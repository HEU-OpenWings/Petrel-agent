import type { PublicUser } from "@petrel/database";

/**
 * Hono 的 context 变量声明。
 *
 * 所有需要认证的路由都用 new Hono<AppEnv>()，这样 c.get("currentUser")
 * 是有类型的，不用在每个 handler 里断言。
 */
export type AppEnv = {
  Variables: {
    currentUser: PublicUser;
  };
};
