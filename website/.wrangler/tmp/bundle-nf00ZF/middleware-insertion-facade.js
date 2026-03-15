				import worker, * as OTHER_EXPORTS from "/home/alessio/dev/oss/polpo/website/src/worker.ts";
				import * as __MIDDLEWARE_0__ from "/home/alessio/dev/oss/polpo/node_modules/.pnpm/wrangler@4.71.0_@cloudflare+workers-types@4.20260307.1/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts";
import * as __MIDDLEWARE_1__ from "/home/alessio/dev/oss/polpo/node_modules/.pnpm/wrangler@4.71.0_@cloudflare+workers-types@4.20260307.1/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts";

				export * from "/home/alessio/dev/oss/polpo/website/src/worker.ts";
				const MIDDLEWARE_TEST_INJECT = "__INJECT_FOR_TESTING_WRANGLER_MIDDLEWARE__";
				export const __INTERNAL_WRANGLER_MIDDLEWARE__ = [
					
					__MIDDLEWARE_0__.default,__MIDDLEWARE_1__.default
				]
				export default worker;