import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import { runInAsyncWorker } from "../services/asyncWorker.js";

type WrappedHandler = RequestHandler & { __asyncWorkerWrapped?: true };

export function endpointWorkerHandler(handler: RequestHandler): RequestHandler {
  const wrapped: WrappedHandler = (req: Request, res: Response, next: NextFunction) => {
    void runInAsyncWorker(async () => {
      await Promise.resolve(handler(req, res, next));
    }).catch(next);
  };
  wrapped.__asyncWorkerWrapped = true;
  return wrapped;
}

export function wrapRouterHandlersInAsyncWorkers<T extends Router>(router: T): T {
  const stack = (router as any)?.stack as Array<any> | undefined;
  if (!Array.isArray(stack)) {
    return router;
  }

  for (const layer of stack) {
    const routeStack = layer?.route?.stack as Array<any> | undefined;
    if (!Array.isArray(routeStack)) {
      continue;
    }

    for (const routeLayer of routeStack) {
      const original = routeLayer?.handle as WrappedHandler | undefined;
      if (typeof original !== "function" || original.__asyncWorkerWrapped) {
        continue;
      }
      routeLayer.handle = endpointWorkerHandler(original);
    }
  }

  return router;
}
