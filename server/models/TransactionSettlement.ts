import { TransactionKind } from '../constants/transaction-kind';
import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Transaction from './Transaction';

export enum TransactionSettlementStatus {
  OWED = 'OWED',
  INVOICED = 'INVOICED',
  SETTLED = 'SETTLED',
}

interface TransactionSettlementAttributes {
  TransactionGroup: string;
  kind: TransactionKind;
  status: TransactionSettlementStatus;
  ExpenseId: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

class TransactionSettlement extends Model<TransactionSettlementAttributes> implements TransactionSettlementAttributes {
  TransactionGroup: string;
  kind: TransactionKind;
  status: TransactionSettlementStatus;
  ExpenseId: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  static async getOwedTransactions(): Promise<typeof Transaction[]> {
    return TransactionSettlement.getTransactionsBySettlementStatus(TransactionSettlementStatus.OWED);
  }

  static async getTransactionsBySettlementStatus(status: TransactionSettlementStatus): Promise<typeof Transaction[]> {
    return sequelize.query(
      `
        SELECT t.*
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        WHERE t."deletedAt" IS NULL
        AND ts."deletedAt" IS NULL
        AND ts."status" = :status`,
      {
        model: Transaction,
        mapToModel: true,
        replacements: { status },
      },
    );
  }
}

TransactionSettlement.init(
  {
    TransactionGroup: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    kind: {
      type: DataTypes.ENUM(...Object.values(TransactionKind)),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(TransactionSettlementStatus)),
      allowNull: false,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'Expenses', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'TransactionSettlements',
    paranoid: true,
  },
);

export default TransactionSettlement;
