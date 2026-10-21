import metadata from '../../package.json';

export const PRODUCT_NAME = metadata.productName;
export const PRODUCT_ID = metadata.name;
export const PRODUCT_VERSION = metadata.version;
// The product rename must preserve existing sessions, identities and Electron preferences.
export const DATA_DIRECTORY_NAME = 'Agent Workbench';
