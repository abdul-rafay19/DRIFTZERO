/**
 * Fixture: small Express 4-style repository for P5 impact analysis tests.
 *
 * This fixture represents a minimal app with routes, middleware, controllers,
 * tests, and a package.json referencing express@4. Used to verify detection
 * without depending on a real remote repository.
 */

export interface FixtureFile {
  path: string;
  content: string;
}

export const express4Fixture: FixtureFile[] = [
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "test-app",
        version: "1.0.0",
        dependencies: {
          express: "^4.18.0",
        },
        devDependencies: {
          "@types/express": "^4.17.0",
          typescript: "^5.0.0",
          vitest: "^1.0.0",
        },
      },
      null,
      2
    ),
  },
  {
    path: "pnpm-lock.yaml",
    content: "lockfileVersion: '6.0'\n",
  },
  {
    path: "tsconfig.json",
    content: JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "CommonJS", strict: true } },
      null,
      2
    ),
  },
  {
    path: "src/index.ts",
    content: `import express from 'express';
import { router } from './routes/users.js';
import { errorHandler } from './middleware/error.js';

const app = express();
app.use(express.json());
app.use('/users', router);
app.use(errorHandler);
app.listen(3000);
`,
  },
  {
    path: "src/routes/users.ts",
    content: `import { Router, Request, Response } from 'express';
export const router = Router();

router.get('/', async (req: Request, res: Response) => {
  res.json({ users: [] });
});

// Using deprecated app.del() equivalent pattern
router.del('/user/:id', (req: Request, res: Response) => {
  res.json({ deleted: req.params.id });
});
`,
  },
  {
    path: "src/middleware/error.ts",
    content: `import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  res.status(500).json({ error: err.message });
}
`,
  },
  {
    path: "src/controllers/userController.ts",
    content: `import { Request, Response } from 'express';
import express from 'express';

export async function getUser(req: Request, res: Response) {
  // controller using express types
  res.json({ id: req.params.id });
}
`,
  },
  {
    path: "src/tests/users.test.ts",
    content: `import express from 'express';
import { router } from '../routes/users.js';
import { describe, it, expect } from 'vitest';

describe('users route', () => {
  it('should return users list', () => {
    expect(true).toBe(true);
  });
});
`,
  },
  // These should be ignored:
  {
    path: "node_modules/express/index.js",
    content: "module.exports = require('./lib/express');",
  },
  {
    path: "dist/index.js",
    content: '"use strict"; const express = require("express");',
  },
  {
    path: ".git/config",
    content: "[core]\nrepositoryformatversion = 0",
  },
  {
    path: "coverage/lcov.info",
    content: "SF:src/index.ts\n",
  },
];
