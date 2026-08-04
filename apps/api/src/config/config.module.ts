import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

/**
 * Global configuration. Validation happens once, at boot — see env.schema.ts.
 *
 * The .env lives at the repo root rather than per-app so there is a single
 * place secrets are kept, and the same file serves the API, the worker, and
 * the Prisma CLI.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      envFilePath: [
        path.resolve(process.cwd(), '.env'),
        path.resolve(process.cwd(), '../../.env'),
      ],
      validate: validateEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
