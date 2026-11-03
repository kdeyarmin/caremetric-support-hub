/** The address of a public help article. The Hub server renders the same address as HTML for crawlers (server/help-center.mjs). */
export const helpArticlePath = (contentKey: string) => `/help/articles/${encodeURIComponent(contentKey)}`;

const articleAddress = /^\/help\/articles\/[^/]+\/?$/;

/** The help center's public pages: the help page, the learning library and each article. Anyone may open them without signing in. */
export const isPublicHelpPath = (pathname: string) => pathname === "/help" || pathname === "/learn" || articleAddress.test(pathname);
