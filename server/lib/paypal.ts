/* eslint-disable camelcase */
import paypal from '@paypal/payouts-sdk';
import config from 'config';
import express from 'express';
import { difference, find } from 'lodash';

import models, { Op } from '../models';
import { paypalRequest } from '../paymentProviders/paypal/api';
import {
  PayoutBatchDetails,
  PayoutRequestBody,
  PayoutRequestResult,
  PaypalWebhook,
  PaypalWebhookEventType,
  PaypalWebhookPatch,
} from '../types/paypal';

import logger from './logger';
import { floatAmountToCents } from './math';

const PAYPAL_WEBHOOK_URL =
  config.env === 'development'
    ? 'https://smee.io/opencollective-paypal-dev-testing' // localhost URLs are not supported by PayPal
    : `${config.host.api}/webhooks/paypal`;

const parseError = e => {
  try {
    return JSON.parse(e.message).message;
  } catch (_) {
    return e.message;
  }
};

type ConnectedAccount = {
  token: string;
  clientId: string;
  settings?: {
    webhookId: string;
  };
};

const getPayPalClient = ({ token, clientId }: ConnectedAccount): ReturnType<typeof paypal.core.PayPalHttpClient> => {
  const environment =
    config.env === 'production'
      ? new paypal.core.LiveEnvironment(clientId, token)
      : new paypal.core.SandboxEnvironment(clientId, token);

  return new paypal.core.PayPalHttpClient(environment);
};

const executeRequest = async (
  connectedAccount: ConnectedAccount,
  request: PayoutRequestBody | Record<string, unknown>,
): Promise<any> => {
  try {
    const client = getPayPalClient(connectedAccount);
    const response = await client.execute(request);
    return response.result;
  } catch (e) {
    throw new Error(parseError(e));
  }
};

export const executePayouts = async (
  connectedAccount: ConnectedAccount,
  requestBody: PayoutRequestBody,
): Promise<PayoutRequestResult> => {
  const request = new paypal.payouts.PayoutsPostRequest();
  request.requestBody(requestBody);
  return executeRequest(connectedAccount, request);
};

export const getBatchInfo = async (
  connectedAccount: ConnectedAccount,
  batchId: string,
): Promise<PayoutBatchDetails> => {
  const request = new paypal.payouts.PayoutsGetRequest(batchId);
  request.page(1);
  request.pageSize(100);
  request.totalRequired(true);
  return executeRequest(connectedAccount, request);
};

export const validateConnectedAccount = async ({ token, clientId }: ConnectedAccount): Promise<void> => {
  const client = getPayPalClient({ token, clientId });
  await client.fetchAccessToken();
};

export const getHostPaypalAccount = async (host): Promise<typeof models.ConnectedAccount> => {
  const [account] = await host.getConnectedAccounts({
    where: { service: 'paypal', clientId: { [Op.not]: null }, token: { [Op.not]: null } },
    order: [['createdAt', 'DESC']],
  });

  if (!account || !account.clientId || !account.token) {
    return null;
  } else {
    return account;
  }
};

export const validateWebhookEvent = async (
  { token, clientId, settings }: ConnectedAccount,
  req: express.Request,
): Promise<void> => {
  const client = getPayPalClient({ token, clientId });
  const request = {
    path: '/v1/notifications/verify-webhook-signature',
    verb: 'POST',
    body: {
      auth_algo: req.get('PAYPAL-AUTH-ALGO'),
      cert_url: req.get('PAYPAL-CERT-URL'),
      transmission_id: req.get('PAYPAL-TRANSMISSION-ID'),
      transmission_sig: req.get('PAYPAL-TRANSMISSION-SIG'),
      transmission_time: req.get('PAYPAL-TRANSMISSION-TIME'),
      webhook_id: settings.webhookId,
      webhook_event: req.body,
    },
    headers: {
      'Content-Type': 'application/json',
    },
  };
  try {
    const response = await client.execute(request);
    if (response?.result?.verification_status !== 'SUCCESS') {
      throw new Error('Invalid webhook request');
    }
  } catch (e) {
    throw new Error(parseError(e));
  }
};

/** Converts a PayPal amount like '12.50' to its value in cents (1250) */
export const paypalAmountToCents = (amountStr: string): number => {
  return floatAmountToCents(parseFloat(amountStr));
};

// ---- Webhooks management ----

/**
 * This array defines all the event types that we're watching in `server/paymentProviders/paypal/webhook.ts`.
 * After adding something here, you'll need to run `scripts/update-hosts-paypal-webhooks.ts` to update
 * all the existing webhooks.
 */
const WATCHED_EVENT_TYPES = [
  // Payouts
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  // Subscriptions
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'PAYMENT.SALE.COMPLETED',
];

/**
 * See https://developer.paypal.com/docs/api/webhooks/v1/#webhooks_list
 */
const listPaypalWebhooks = async (host): Promise<PaypalWebhook[]> => {
  const result = await paypalRequest('notifications/webhooks', null, host, 'GET');
  return <PaypalWebhook[]>result['webhooks'];
};

/**
 * See https://developer.paypal.com/docs/api/webhooks/v1/#webhooks_post
 */
const createPaypalWebhook = async (host, webhookData): Promise<PaypalWebhook> => {
  return <PaypalWebhook>await paypalRequest(`notifications/webhooks`, webhookData, host, 'POST');
};

/**
 * See https://developer.paypal.com/docs/api/webhooks/v1/#webhooks_update
 */
const updatePaypalWebhook = async (
  host,
  webhookId: string,
  patchRequest: PaypalWebhookPatch,
): Promise<PaypalWebhook> => {
  return <PaypalWebhook>await paypalRequest(`notifications/webhooks/${webhookId}`, patchRequest, host, 'PATCH');
};

/**
 * See https://developer.paypal.com/docs/api/webhooks/v1/#webhooks_get
 */
const getPaypalWebhook = async (host, webhookId): Promise<PaypalWebhook> => {
  return <PaypalWebhook>await paypalRequest(`notifications/webhooks/${webhookId}`, null, host, 'GET');
};

/**
 * See https://developer.paypal.com/docs/api/webhooks/v1/#webhooks_delete
 */
const deletePaypalWebhook = async (host, webhookId): Promise<void> => {
  await paypalRequest(`notifications/webhooks/${webhookId}`, null, host, 'DELETE');
};

const isOpenCollectiveWebhook = (webhook: PaypalWebhook): boolean => {
  return webhook.url === PAYPAL_WEBHOOK_URL;
};

/**
 * Check if a webhook has all event types required by Open Collective
 */
const isCompatibleWebhook = (webhook: PaypalWebhook): boolean => {
  if (!isOpenCollectiveWebhook(webhook)) {
    return false;
  } else {
    const webhookEvents = webhook['event_types'].map(event => event.name);
    const differences = difference(WATCHED_EVENT_TYPES, webhookEvents);
    return differences.length === 0;
  }
};

/**
 * Check if the connected account setup for this host is compatible with our system
 */
const hostPaypalWebhookIsReady = async (host): Promise<boolean> => {
  const connectedAccount = await getHostPaypalAccount(host);
  const webhookId = connectedAccount?.settings?.webhookId;
  if (!webhookId) {
    return false;
  }

  const webhook = await getPaypalWebhook(host, webhookId);
  return webhook ? isCompatibleWebhook(webhook) : false;
};

const updatePaypalAccountWithWebhook = async (connectedAccount, webhook: PaypalWebhook) => {
  if (connectedAccount.settings?.webhookId === webhook.id) {
    return connectedAccount; // Nothing to do
  }

  return connectedAccount.update({ settings: { ...connectedAccount.settings, webhookId: webhook.id } });
};

/**
 * If needed, create a new webhook on PayPal and update host's connected account with its new info
 */
export const setupPaypalWebhookForHost = async (host): Promise<void> => {
  if (await hostPaypalWebhookIsReady(host)) {
    logger.debug(`Host ${host.slug} already has a compatible webhook linked, skipping`);
    return;
  }

  let newWebhook;
  const connectedAccount = await getHostPaypalAccount(host);
  const existingWebhooks = await listPaypalWebhooks(host);
  const existingOCWebhook = find(existingWebhooks, isOpenCollectiveWebhook);

  if (existingOCWebhook) {
    if (isCompatibleWebhook(existingOCWebhook)) {
      // Link webhook directly if it has the right events
      logger.info(`Found an existing PayPal webhook to use, linking ${existingOCWebhook.id} to ${host.slug}`);
      newWebhook = existingOCWebhook;
    } else {
      // Update webhook
      logger.info(`Updating PayPal webhook ${existingOCWebhook.id} for ${host.slug}`);
      const eventTypes = <PaypalWebhookEventType[]>WATCHED_EVENT_TYPES.map(name => ({ name }));
      const patchRequest = [{ op: 'replace', path: '/event_types', value: eventTypes }];
      newWebhook = await updatePaypalWebhook(host, existingOCWebhook.id, patchRequest);
    }
  } else {
    // Create webhook
    logger.info(`Creating PayPal webhook for ${host.slug}`);
    const eventTypes = WATCHED_EVENT_TYPES.map(name => ({ name }));
    const webhookData = { url: PAYPAL_WEBHOOK_URL, event_types: eventTypes };
    newWebhook = await createPaypalWebhook(host, webhookData);
  }

  await updatePaypalAccountWithWebhook(connectedAccount, newWebhook);
};

/**
 * Removes all the Paypal webhooks pointing to Open Collective that are currently not used
 */
export const removeUnusedPaypalWebhooks = async (host): Promise<number> => {
  const connectedAccount = await getHostPaypalAccount(host);
  const currentWebhookId = connectedAccount?.settings?.webhookId;
  const allHostWebhooks = await listPaypalWebhooks(host);
  let deletedCount = 0;

  for (const webhook of allHostWebhooks) {
    if (webhook.url === PAYPAL_WEBHOOK_URL && webhook.id !== currentWebhookId) {
      await deletePaypalWebhook(host, webhook.id);
      deletedCount += 1;
    }
  }

  return deletedCount;
};

export { paypal };
