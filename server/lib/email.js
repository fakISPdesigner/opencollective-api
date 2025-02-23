import fs from 'fs';
import path from 'path';

import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import juice from 'juice';
import { get, includes, isArray, merge, pick } from 'lodash';
import nodemailer from 'nodemailer';

import models from '../models';

import templates from './emailTemplates';
import logger from './logger';
import { isEmailInternal, md5, sha512 } from './utils';
import whiteListDomains from './whiteListDomains';

const debug = debugLib('email');

export const NO_REPLY_EMAIL = 'Open Collective <no-reply@opencollective.com>';

export const getMailer = () => {
  if (config.maildev.client) {
    return nodemailer.createTransport({
      ignoreTLS: true,
      port: 1025,
    });
  }
  if (get(config, 'mailgun.user') && get(config, 'mailgun.password')) {
    return nodemailer.createTransport({
      service: 'Mailgun',
      auth: {
        user: get(config, 'mailgun.user'),
        pass: get(config, 'mailgun.password'),
      },
    });
  }
};

const render = (template, data) => {
  let text;
  data.imageNotSvg = data.collective && data.collective.image && !data.collective.image.endsWith('.svg');
  data = merge({}, data);
  delete data.config;
  data.config = { host: config.host };

  if (templates[`${template}.text`]) {
    text = templates[`${template}.text`](data);
  }

  const html = juice(templates[template](data));

  return { text, html };
};

const generateUnsubscribeToken = (email, collectiveSlug, type, hashingFunction = sha512) => {
  const uid = `${email}.${collectiveSlug || 'any'}.${type}.${config.keys.opencollective.emailUnsubscribeSecret}`;
  const token = hashingFunction(uid);
  return token;
};

const isValidUnsubscribeToken = (token, email, collectiveSlug, type) => {
  // Check token using the latest procedure
  const computedToken = emailLib.generateUnsubscribeToken(email, collectiveSlug, type, sha512);
  if (computedToken === token) {
    return true;
  }

  // Backward-compatibility: check legacy tokens
  return emailLib.generateUnsubscribeToken(email, collectiveSlug, type, md5) === token;
};

/*
 * Gets the body from a string (usually a template)
 */
const getTemplateAttributes = str => {
  let index = 0;
  const lines = str.split('\n');
  const attributes = {};
  let tokens;
  do {
    tokens = lines[index++].match(/^([a-z]+):(.+)/i);
    if (tokens) {
      attributes[tokens[1].toLowerCase()] = tokens[2].replace(/<br( \/)?>/g, '\n').trim();
    }
  } while (tokens);

  attributes.body = lines.slice(index).join('\n').trim();
  return attributes;
};

const filterBccForTestEnv = emails => {
  if (!emails) {
    return emails;
  }

  const isString = typeof emails === 'string';
  const list = isString ? emails.split(',') : emails;
  const filtered = list.filter(isEmailInternal);
  return isString ? filtered.join(',') : filtered;
};

/*
 * sends an email message to a recipient with given subject and body
 */
const sendMessage = (recipients, subject, html, options = {}) => {
  options.bcc = options.bcc || 'emailbcc@opencollective.com';

  if (!isArray(recipients)) {
    recipients = [recipients];
  }

  recipients = recipients.filter(recipient => {
    if (!recipient || !recipient.match(/.+@.+\..+/)) {
      debug(`${recipient} is an invalid email address, skipping`);
      return false;
    } else {
      return true;
    }
  });

  if (config.env === 'staging') {
    subject = `[STAGING] ${subject}`;
  } else if (config.env !== 'production' && config.host.website !== 'https://opencollective.com') {
    subject = `[TESTING] ${subject}`;
  }

  let to;
  if (recipients.length > 0) {
    to = recipients.join(', ');
  }

  // When in preview mode, we export an HTML version of the email in `/tmp/:template.:recipientSlug.html`
  if (process.env.DEBUG && process.env.DEBUG.match(/preview/)) {
    let filepath;
    const recipientSlug = to.substr(0, to.indexOf('@'));
    filepath = path.resolve(`/tmp/${options.tag}.${recipientSlug}.html`);
    fs.writeFileSync(filepath, html);
    console.log('>>> preview email', filepath);
    if (options.text) {
      filepath = `/tmp/${options.tag}.${recipientSlug}.txt`;
      fs.writeFileSync(filepath, options.text);
      console.log('>>> preview email', filepath);
    }

    if (options.attachments) {
      options.attachments.map(attachment => {
        const filepath = path.resolve(`/tmp/${attachment.filename}`);
        fs.writeFileSync(filepath, attachment.content);
        console.log('>>> preview attachment', filepath);
      });
    }
  }

  if (process.env.ONLY) {
    debug('Only sending email to ', process.env.ONLY);
    to = process.env.ONLY;
  } else if (config.env !== 'production') {
    if (!to) {
      debug('emailLib.sendMessage error: No recipient defined');
      return Promise.resolve();
    }

    // Filter users added as BCC
    options.bcc = filterBccForTestEnv(options.bcc);

    let sendToBcc = true;
    // Don't send to BCC if sendEvenIfNotProduction and NOT in testing env
    if (options.sendEvenIfNotProduction === true && !['ci', 'test'].includes(config.env)) {
      sendToBcc = false;
    }
    if (sendToBcc) {
      to = `emailbcc+${to.replace(/@/g, '-at-')}@opencollective.com`;
    }
  }

  if (recipients.length === 0) {
    debug('emailLib.sendMessage error: No recipient to send to, only sending to bcc', options.bcc);
  }

  const mailer = getMailer();
  if (mailer) {
    return new Promise((resolve, reject) => {
      const from = options.from || config.email.from;
      const replyTo = options.replyTo;
      const cc = options.cc;
      const bcc = options.bcc;
      const text = options.text;
      const attachments = options.attachments;

      // only attach tag in production to keep data clean
      const tag = config.env === 'production' ? options.tag : 'internal';
      const headers = { 'X-Mailgun-Tag': tag, 'X-Mailgun-Dkim': 'yes' };
      if (replyTo) {
        headers['Reply-To'] = replyTo;
      }
      debug('mailer> sending email to ', to, 'bcc', bcc);

      return mailer.sendMail({ from, cc, to, bcc, subject, text, html, headers, attachments }, (err, info) => {
        if (err) {
          debug('>>> mailer.sendMail error', err);
          return reject(err);
        } else {
          debug('>>> mailer.sendMail success', info);
          return resolve(info);
        }
      });
    });
  } else {
    debug('>>> mailer not configured');
    return Promise.resolve();
  }
};

/**
 * Get the label to unsubscribe from the email notification
 * Shown in the footer of the email following "To unsubscribe from "
 */
const getNotificationLabel = (template, recipients) => {
  if (!isArray(recipients)) {
    recipients = [recipients];
  }

  template = template.replace('.text', '');

  const notificationTypeLabels = {
    'email.approve': 'notifications of new emails pending approval',
    'email.message': `the ${recipients[0].substr(0, recipients[0].indexOf('@'))} mailing list`,
    'collective.order.created': 'notifications of new donations for this collective',
    'collective.comment.created': 'notifications of new comments submitted to this collective',
    'collective.expense.created': 'notifications of new expenses submitted to this collective',
    'collective.expense.approved.for.host': 'notifications of new expenses approved under this host',
    'collective.expense.paid.for.host': 'notifications of new expenses paid under this host',
    'collective.monthlyreport': 'monthly reports for collectives',
    'collective.member.created': 'notifications of new members',
    'collective.update.published': 'notifications of new updates from this collective',
    'host.monthlyreport': 'monthly reports for host',
    'host.yearlyreport': 'yearly reports for host',
    'collective.transaction.created': 'notifications of new transactions for this collective',
    onboarding: 'onboarding emails',
    'user.monthlyreport': 'monthly reports for backers',
    'user.yearlyreport': 'yearly reports',
    thankyou: 'thank you for your donation',
  };

  return notificationTypeLabels[template];
};

const isWhitelistedDomain = email => {
  const domain = email.split('@');
  return whiteListDomains.includes(domain[1].toLowerCase());
};

/*
 * Given a template, recipient and data, generates email.
 */
const generateEmailFromTemplate = (template, recipient, data = {}, options = {}) => {
  const slug = get(options, 'collective.slug') || get(data, 'collective.slug') || 'undefined';
  const hostSlug = get(data, 'host.slug');
  const eventSlug = get(data, 'event.slug');

  // If we are sending the same email to multiple recipients, it doesn't make sense to allow them to unsubscribe
  if (!isArray(recipient)) {
    data.notificationTypeLabel = getNotificationLabel(options.type || template, recipient);
    data.unsubscribeUrl = `${config.host.website}/email/unsubscribe/${encodeURIComponent(
      recipient || options.bcc,
    )}/${slug}/${options.type || template}/${generateUnsubscribeToken(
      recipient || options.bcc,
      slug,
      options.type || template,
    )}`;
  }

  if (template === 'ticket.confirmed') {
    if (slug === 'fearlesscitiesbrussels') {
      template += '.fearlesscitiesbrussels';
    }
    if (eventSlug === 'open-2020-networked-commons-initiatives-9b91f4ca') {
      template += '.open-2020';
    }
  }

  if (template === 'collective.approved') {
    if (hostSlug === 'the-social-change-nest') {
      template += '.the-social-change-nest';
    }
  }

  if (template === 'collective.created') {
    if (hostSlug === 'opensource') {
      template += '.opensource';
    }
    if (hostSlug === 'the-social-change-nest') {
      template += '.the-social-change-nest';
    }
  }

  if (template.match(/^host\.(monthly|yearly)report$/)) {
    template = 'host.report';
  }

  if (template === 'thankyou') {
    if (slug.match(/wwcode/)) {
      template = 'thankyou.wwcode';
    } else if (['foundation', 'opensource'].includes(hostSlug)) {
      template = `thankyou.${hostSlug}`;
    } else if (includes(['chsf', 'kendraio', 'brusselstogether', 'sustainoss', 'ispcwa'], slug)) {
      template = `thankyou.${slug}`;
    } else if (includes(['laprimaire', 'lesbarbares', 'nuitdebout', 'enmarchebe', 'monnaie-libre'], slug)) {
      if (slug === 'laprimaire') {
        template = 'thankyou.laprimaire';
      } else {
        template = 'thankyou.fr';
      }

      // xdamman: hack
      switch (data.interval) {
        case 'month':
          data.interval = 'mois';
          break;
        case 'year':
          data.interval = 'an';
          break;
      }
    }
  }

  if (template === 'collective.member.created') {
    if (get(data, 'member.memberCollective.twitterHandle') && get(data, 'member.role') === 'BACKER') {
      const collectiveMention = get(data, 'collective.twitterHandle')
        ? `@${data.collective.twitterHandle}`
        : data.collective.name;
      const text = `Hi @${
        data.member.memberCollective.twitterHandle
      } thanks for your financial contribution to ${collectiveMention} ${config.host.website}${get(
        data,
        'collective.urlPath',
      )} 🎉😊`;
      data.tweet = {
        text,
        encoded: encodeURIComponent(text),
      };
    }
  }

  data.config = pick(config, ['host']);
  data.utm = `utm_source=opencollective&utm_campaign=${template}&utm_medium=email`;

  if (!templates[template]) {
    return Promise.reject(new Error(`Invalid email template: ${template}`));
  }

  const renderedTemplate = render(template, data);

  return Promise.resolve(renderedTemplate);
};

const isNotificationActive = async (template, data) => {
  if (data.user && data.user.id) {
    return models.Notification.isActive(template, data.user, data.collective);
  } else {
    return true;
  }
};

/*
 * Given a template, recipient and data, generates email and sends it.
 */
const generateEmailFromTemplateAndSend = async (template, recipient, data, options = {}) => {
  if (!recipient) {
    logger.info(`Email with template '${template}' not sent. No recipient.`);
    return;
  }

  const notificationIsActive = await isNotificationActive(template, data);
  if (!notificationIsActive) {
    logger.info(`Email with template '${template}' not sent. Recipient email notification is not active.`);
    return;
  }

  return generateEmailFromTemplate(template, recipient, data, options)
    .then(renderedTemplate => {
      const attributes = getTemplateAttributes(renderedTemplate.html);
      options.text = renderedTemplate.text;
      options.tag = template;
      debug(`Sending email to: ${recipient} subject: ${attributes.subject}`);
      return emailLib.sendMessage(recipient, attributes.subject, attributes.body, options);
    })
    .catch(err => {
      logger.error(err.message);
      logger.debug(err);
    });
};

const emailLib = {
  render,
  getTemplateAttributes,
  sendMessage,
  generateUnsubscribeToken,
  isValidUnsubscribeToken,
  generateEmailFromTemplate,
  send: generateEmailFromTemplateAndSend,
  isWhitelistedDomain,
};

export default emailLib;
