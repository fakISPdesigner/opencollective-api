import { TransactionKind } from '../constants/transaction-kind';
import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

class TransactionSettlement extends Model {
  id: string;
  ProductId: string;
  currency: string;
  interval: string;
  amount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
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
      type: DataTypes.ENUM('OWED', 'INVOICED', 'SETTLED'),
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
