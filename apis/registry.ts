import { app as webChecker } from "./web-checker/index";
import type { Hono } from "hono";
import { app as httpStatusChecker } from "./http-status-checker/index";


export const registry: Record<string, Hono> = {
  check: webChecker,
  "http-status-checker": httpStatusChecker,
};
