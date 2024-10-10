import { OAuth2Client } from 'google-auth-library';
import AWS from 'aws-sdk';
import https from 'https';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const client = new OAuth2Client(CLIENT_ID);

export const handler = async (event) => {
  try {
    const startTime = Date.now();

    // client send access token as "Bearer ..." in autorization http field
    const accessToken = event.headers.authorization.split(' ')[1];
    const idToken = await client.getTokenInfo(accessToken);

    // we have CLIENT_ID in this function env variable, and token should be issued for the same client ID
    if (idToken.aud !== CLIENT_ID) {
      return returnHTTP(401, 'Access token is not intended for this client');
    }

    const dbUser = await getDBUser(idToken.email);
    if (!dbUser.Item)
      return returnHTTP(401, 'User does not exist');
    if (dbUser.Item.Balance < 0)
      return returnHTTP(402, 'User has insufficient balance');

    const response = await makeOpenAIRequest(event.body);

    const endTime = Date.now();
    const transaction = {
      userId: idToken.email,
      model: response?.model,
      resTokens: response?.usage?.completion_tokens,
      reqTokens: response?.usage?.prompt_tokens,
      duration: (endTime - startTime) / 1000
    }
    await logTransaction(transaction);

    const transactionPrice = getTransactionPrice(response);
    await deductUserBalance(idToken.email, transactionPrice);

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    }
  } catch (err) {
    // If the token is invalid, return an error response
    return {
      statusCode: 401,
      body: JSON.stringify({
        message: 'Token is invalid',
        error: err.message,
      }),
    };
  }
};

function makeOpenAIRequest(body) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      }
    };

    const req = https.request(OPENAI_URL, requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Request failed with status code ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.write(body);
    req.end();
  });
}

async function logTransaction(transaction) {
  const transactionParams = {
      TableName: 'TransactionData',
      Item: {
          'TransactionID': 'txn-' + Date.now(),
          'UserID': transaction.userId,
          'Model': transaction.model,
          'ReqTokens': transaction.reqTokens,
          'ResTokens': transaction.resTokens,
          'Duration': transaction.duration
      }
  };
  await dynamoDB.put(transactionParams).promise();
}

// check if user exist in dynamoDB table "UserAccountData"
async function getDBUser(userId) {
  const userParams = {
      TableName: 'UserAccountData',
      Key: {
          'UserID': userId
      }
  };
  return dynamoDB.get(userParams).promise();
}

async function deductUserBalance(userId, amountToDeduct) {
  const userParams = {
    TableName: 'UserAccountData',
    Key: {
      'UserID': userId
    },
    UpdateExpression: 'set Balance = Balance - :amount',
    ExpressionAttributeValues: {
      ':amount': amountToDeduct
    },
    ReturnValues: 'UPDATED_NEW'
  };

  try {
    const result = await dynamoDB.update(userParams).promise();
    console.log('Updated balance:', result.Attributes.Balance);
    return result.Attributes.Balance;
  } catch (error) {
    console.error('Error deducting balance:', error);
    throw error;
  }
}


function returnHTTP(statusCode, message, error = "") {
  return {
    statusCode: statusCode,
    body: JSON.stringify({
      message,
      error
    })
  }
}

function getTransactionPrice(response) {
  const inputPrice = modelPrice[response?.model]?.input || 0;
  const outputPrice = modelPrice[response?.model]?.output || 0;
  const promptPrice = (response?.usage?.prompt_tokens / 1000) * inputPrice;
  const completionPrice = (response?.usage?.completion_tokens / 1000) * outputPrice;
  return promptPrice + completionPrice + 0.00000213;
}

const modelPrice = {
  "gpt-4": {
    input: 0.03,
    output: 0.06
  },
  "gpt-4o": {
    input: 0.00250,
    c_input: 0.00125,
    output: 0.01000
  },
  "gpt-4o-mini": {
    input: 0.000150,
    c_input: 0.075,
    output: 0.0006
  },
  "gpt-4-turbo": {
    input: 0.01,
    output: 0.03
  },
  "gpt-3.5-turbo": {
    input: 0.0015,
    output: 0.002
  }
}