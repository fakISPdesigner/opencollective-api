#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { entries, groupBy } from 'lodash';
import moment from 'moment';

import { getPlatformFeesPathMonthTransactions, settleDebtsLegacy } from '../../server/lib/invoice-platform-fees';
import models from '../../server/models';

const date = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();
const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';

// Only run on the 1th of the month
if (isProduction && date.date() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
}

if (DRY) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

export async function runLegacy() {
  console.info(`Invoicing hosts pending fees and tips for ${moment(date).subtract(1, 'month').format('MMMM')}.`);
  const pastMonthTransactions = await getPlatformFeesPathMonthTransactions(date);
  const byHost = groupBy(pastMonthTransactions, 'HostCollectiveId');

  for (const [hostId, hostTransactions] of entries(byHost)) {
    if (HOST_ID && hostId != HOST_ID) {
      continue;
    }

    const host = await models.Collective.findByPk(hostId);
    const { currency, chargedHostId } = hostTransactions[0];

    if (!DRY) {
      await settleDebtsLegacy(host, currency, hostTransactions, date, chargedHostId);
    }
  }
}

if (require.main === module) {
  runLegacy()
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
