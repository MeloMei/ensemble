import metadata from '../../package.json';

export const DATA_SCHEMA_VERSION = metadata.ensemble.dataSchemaVersion;
if (!Number.isSafeInteger(DATA_SCHEMA_VERSION) || DATA_SCHEMA_VERSION < 1) throw new Error('应用的数据格式声明无效。');
