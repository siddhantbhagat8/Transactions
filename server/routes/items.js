/**
 * @file Defines all routes for the Items route.
 */

const express = require('express');
const axios = require('axios');
const Boom = require('@hapi/boom');
const {
  retrieveItemById,
  retrieveItemByPlaidInstitutionId,
  retrieveAccountsByItemId,
  createItem,
  deleteItem,
  updateItemStatus,
  createAccount,
  updateBalances,
  createTransfer,
} = require('../db/queries');
const { asyncWrapper } = require('../middleware');
const plaid = require('../plaid');
const {
  sanitizeAccounts,
  sanitizeItems,
  isValidItemStatus,
  validItemStatuses,
} = require('../util');

const router = express.Router();

const DWOLLA_ACCESS_TOKEN = process.env.DWOLLA_ACCESS_TOKEN;
const DWOLLA_MASTER_ACCOUNT_ID = process.env.DWOLLA_MASTER_ACCOUNT_ID;
const DWOLLA_BASE_URL = 'https://api-sandbox.dwolla.com';

/**
 * First exchanges a public token for a private token via the Plaid API and
 * stores the newly created item in the DB.  Then fetches auth data or processor token and identity data from
 * the Plaid API and creates and stores newly created account in the DB.
 *
 * @param {string} publicToken public token returned from the onSuccess call back in Link.
 * @param {string} institutionId the Plaid institution ID of the new item.
 * @param {string} userId the Plaid user ID of the active user.
 * @param {object} accounts the accounts chosen by the user from the onSuccess metadata.
 * @param {boolean} isProcessor false if developer is using a Plaid partner (processor)
 * @param {boolean} isIdentity true if in identity mode.
 */

// create Dwolla Customer and obtain customer url
const createDwollaCustomer = async (firstName, lastName) => {
  try {
    const response = await axios.post(
      `${DWOLLA_BASE_URL}/customers`,
      {
        firstName: firstName,
        lastName: lastName,
        email: `${Math.random() // because Dwolla does not allow identical emails, and sandbox data is always the same.
          .toString(36)
          .slice(2)}@sampleApp.com`,
        ipAddress: '99.99.99.99', // dummy data: a unique identifier for Dwolla
      },
      {
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${DWOLLA_ACCESS_TOKEN}`,
          Accept: 'application/vnd.dwolla.v1.hal+json',
        },
      }
    );
    return response.headers.location;
  } catch (error) {
    console.log('error:', error);
    res.status(500);
  }
};

// send processor token to Dwolla customer url to create customer Funding source and obtain customer funding source url
const createDwollaCustomerFundingSource = async (
  account,
  customerUrl,
  processorToken
) => {
  try {
    const response = await axios.post(
      `${customerUrl}/funding-sources`,
      {
        plaidToken: processorToken,
        name: account.subtype,
      },
      {
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${DWOLLA_ACCESS_TOKEN}`,
          Accept: 'application/vnd.dwolla.v1.hal+json',
        },
      }
    );
    return response.headers.location;
  } catch (error) {
    console.log('error:', error);
    res.status(500);
  }
};

router.post(
  '/',
  asyncWrapper(async (req, res) => {
    const {
      publicToken,
      institutionId,
      userId,
      accounts,
      isProcessor,
      isIdentity,
    } = req.body;

    // exchange the public token for a private access token and store with the item.
    const response = await plaid.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    const newItem = await createItem(
      institutionId,
      accessToken,
      itemId,
      userId
    );

    // in case developer did not customize their Account Select in the dashboard to enable only one account,
    // choose the checking or savings account.
    const checkingAccount = accounts.filter(
      account => account.subtype === 'checking'
    );
    const savingsAccount = accounts.filter(
      account => account.subtype === 'savings'
    );
    const account =
      accounts.length === 1
        ? accounts[0]
        : checkingAccount.length > 0
        ? checkingAccount[0]
        : savingsAccount[0];

    // the request is the same for both auth and identity calls
    const authAndIdRequest = {
      access_token: accessToken,
      options: {
        account_ids: [account.id],
      },
    };
    // identity info will remain null if not identity
    let emails = null;
    let ownerNames = null;
    let firstName = 'firstName';
    let lastName = 'lastName';

    // auth numbers will remain null if not auth
    let authNumbers = {
      account: null,
      routing: null,
      wire_routing: null,
    };

    // balances will be null if not auth or identity, only until the first transfer is made
    // and accounts/balance/get is called
    let balances = {
      available: null,
      current: null,
      iso_currency_code: null,
      unofficial_currency_code: null,
    };

    // ADD CODE FOR CHECKPOINT 2 ON THIS LINE
    if (isIdentity) {
      const identityResponse = await plaid.identityGet(authAndIdRequest);
      emails = identityResponse.data.accounts[0].owners[0].emails.map((email) => {
        return email.data;
      });
    
      ownerNames = identityResponse.data.accounts[0].owners[0].names;
      const fullName = ownerNames[0].split(" ");
      firstName = fullName[0];
      lastName = fullName[fullName.length - 1];
    
      if (isProcessor) {
        balances = identityResponse.data.accounts[0].balances;
      }
    }

    if (isIdentity && emails != null && ownerNames != null) {
      console.log('Checkpoint #2 done!');
      console.log('owner:', firstName, lastName);
      console.log('email:', emails[0]);
      console.log('balances:', balances);
    }else{
      console.log("Checkpoint #2: no identity check yet")
    }
    // processorToken is only set if IS_PROCESSOR is true in .env file
    let processorToken = null;
    let customerUrl = null;
    let fundingSourceUrl = null;

    // ADD CODE FOR CHECKPOINT 3 ON THIS LINE
    if (!isProcessor) {
      authResponse = await plaid.authGet(authAndIdRequest);
      authNumbers = authResponse.data.numbers.ach[0];
      balances = authResponse.data.accounts[0].balances;
    } else {
      const processorRequest = {
        access_token: accessToken,
        account_id: account.id,
        processor: "dwolla",
      };
      const processorTokenResponse = await plaid.processorTokenCreate(
        processorRequest
      );
      processorToken = processorTokenResponse.data.processor_token;
    
      customerUrl = await createDwollaCustomer(firstName, lastName);
    
      fundingSourceUrl = await createDwollaCustomerFundingSource(
        account,
        customerUrl,
        processorToken
      );
    }

    if (isProcessor && processorToken != null) {
      console.log('Checkpoint #3 done!');
      console.log('processorToken:', processorToken);
      console.log('Dwolla customer url:', customerUrl);
      console.log('Dwolla customer funding source  url:', fundingSourceUrl);
    }else{
      console.log("Checkpoint #3: no processor token yet")
    }

    // if not isProcessor, processorToken, customerUrl and fundingSouceUrl will all be null
    const newAccount = await createAccount(
      itemId,
      userId,
      account,
      balances,
      authNumbers,
      ownerNames,
      emails,
      processorToken,
      customerUrl,
      fundingSourceUrl
    );

    res.json({
      items: sanitizeItems(newItem),
      accounts: sanitizeAccounts(newAccount),
    });
  })
);

// Make Dwolla transfer from customer funding source to app's master account.  Obtain Dwolla transfer url
// and save to transfers table.
// TODO:  make transfers provider and obtain transfers by item to disply on UI.

router.post(
  '/makeTransfer',
  asyncWrapper(async (req, res) => {
    const { fundingSourceUrl, amount, itemId } = req.body;
    let transUrl = null;
    let confirmedAmount = null;
    try {
      const response = await axios.post(
        `${DWOLLA_BASE_URL}/transfers`,
        {
          _links: {
            source: {
              href: fundingSourceUrl,
            },
            destination: {
              href: `${DWOLLA_BASE_URL}/funding-sources/${DWOLLA_MASTER_ACCOUNT_ID}`,
            },
          },
          amount: {
            currency: 'USD',
            value: `${amount}`,
          },
        },
        {
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${DWOLLA_ACCESS_TOKEN}`,
            Accept: 'application/vnd.dwolla.v1.hal+json',
          },
        }
      );
      transUrl = response.headers.location;
    } catch (error) {
      console.log('error:', error);
      res.status(500);
    }

    // get the confirmed amount from the transfer url
    try {
      const response = await axios.get(transUrl, {
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${DWOLLA_ACCESS_TOKEN}`,
          Accept: 'application/vnd.dwolla.v1.hal+json',
        },
      });

      confirmedAmount = response.data.amount.value;
    } catch (error) {
      console.log('error:', error);
      res.status(500);
    }
    const transfer = await createTransfer(itemId, confirmedAmount, transUrl);
    res.json({ transfer: transfer });
  })
);
/**
 * Retrieves a single item.
 *
 * @param {string} itemId the ID of the item.
 * @returns {Object[]} an array containing a single item.
 */
router.get(
  '/:itemId',
  asyncWrapper(async (req, res) => {
    const { itemId } = req.params;
    const item = await retrieveItemById(itemId);
    res.json(sanitizeItems(item));
  })
);

/**
 * Updates a single item.
 *
 * @param {string} itemId the ID of the item.
 * @returns {Object[]} an array containing a single item.
 */
router.put(
  '/:itemId',
  asyncWrapper(async (req, res) => {
    const { itemId } = req.params;
    const { status } = req.body;

    if (status) {
      if (!isValidItemStatus(status)) {
        throw new Boom(
          'Cannot set item status. Please use an accepted value.',
          {
            statusCode: 400,
            acceptedValues: [validItemStatuses.values()],
          }
        );
      }
      await updateItemStatus(itemId, status);
      const item = await retrieveItemById(itemId);
      res.json(sanitizeItems(item));
    } else {
      throw new Boom('You must provide updated item information.', {
        statusCode: 400,
        acceptedKeys: ['status'],
      });
    }
  })
);

    // ADD CODE FOR CHECKPOINT 6 ON THIS LINE
    /**
 * Updates balances on account
 *
 * @param {number} itemId the ID of the item.
 * @param {string} accountId the account id.
 * @returns {Object[]} an array containing a single account.
 */
router.put(
  "/:itemId/balance",
  asyncWrapper(async (req, res) => {
    const { itemId } = req.params;
    const { accountId } = req.body;
    const { plaid_access_token: accessToken } = await retrieveItemById(itemId);
    const balanceRequest = {
      access_token: accessToken,
      options: {
        account_ids: [accountId],
      },
    };

    const balanceResponse = await plaid.accountsBalanceGet(balanceRequest);

    const account = balanceResponse.data.accounts[0];
    const updatedAccount = await updateBalances(
      accountId,
      account.balances.current,
      account.balances.available
    );
    console.log(`Checkpoint 6 complete!`);
    console.log(`Available balance:`, account.balances.available);
    res.json(updatedAccount[0]);
  })
);

/**
 * Deletes a single item and related accounts and transactions.
 * Also removes the item from the Plaid API
 * access_token associated with the Item is no longer valid
 * https://plaid.com/docs/#remove-item-request
 * @param {string} itemId the ID of the item.
 * @returns status of 204 if successful
 */
router.delete(
  '/:itemId',
  asyncWrapper(async (req, res) => {
    const { itemId } = req.params;
    const { plaid_access_token: accessToken } = await retrieveItemById(itemId);
    /* eslint-disable camelcase */
    try {
      const response = await plaid.itemRemove({
        access_token: accessToken,
      });
      const removed = response.data.removed;
      const status_code = response.data.status_code;
    } catch (error) {
      if (!removed)
        throw new Boom('Item could not be removed in the Plaid API.', {
          statusCode: status_code,
        });
    }
    await deleteItem(itemId);

    res.sendStatus(204);
  })
);

/**
 * Retrieves all accounts associated with a single item.
 *
 * @param {string} itemId the ID of the item.
 * @returns {Object[]} an array of accounts.
 */
router.get(
  '/:itemId/accounts',
  asyncWrapper(async (req, res) => {
    const { itemId } = req.params;
    const accounts = await retrieveAccountsByItemId(itemId);
    res.json(sanitizeAccounts(accounts));
  })
);

/**
 * -- This endpoint will only work in the sandbox enviornment --
 * Forces an Item into an ITEM_LOGIN_REQUIRED (bad) error state.
 * An ITEM_LOGIN_REQUIRED webhook will be fired after a call to this endpoint.
 * https://plaid.com/docs/#managing-item-states
 *
 * @param {string} itemId the Plaid ID of the item.
 * @return {Object} the response from the Plaid API.
 */
router.post(
  '/sandbox/item/reset_login',
  asyncWrapper(async (req, res) => {
    try {
      const { itemId } = req.body;
      const { plaid_access_token: accessToken } = await retrieveItemById(
        itemId
      );
      const resetResponse = await plaid.sandboxItemResetLogin({
        access_token: accessToken,
      });
      res.json(resetResponse.data);
    } catch (error) {
      if (error.response && error.response.status === 400) {
        console.log(
          'Ngrok webhook addresses are only valid for 2 hours and only during the session in which an item is created; for previously created items, no webhook will be received from the call to sandboxItemResetLogin. If your current session has been longer than 2 hours, restart your server to test the item reset login.  Otherwise, create a new item to test. For more information, see the troubleshooting guide in the readme file.'
        );
      }
    }
  })
);

module.exports = router;
