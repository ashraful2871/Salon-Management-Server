import config from "../../config";

/**
 * The product name ("Stylio" unless `SITE_NAME` says otherwise). Every email,
 * subject line, message and label the API writes reads it from here, so the
 * name is never typed out anywhere else.
 */
export const SITE_NAME = config.siteName;
