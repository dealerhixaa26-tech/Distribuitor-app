import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { map, type Observable } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';

/**
 * Wraps handler results in the `{ data }` envelope and normalises types that
 * JSON cannot represent safely.
 *
 * The Decimal and BigInt handling is the important part. `JSON.stringify` turns
 * a Prisma Decimal into a JSON number, silently reintroducing the IEEE-754
 * precision loss that ADR-0004 exists to prevent, and throws outright on
 * BigInt. Converting both to strings here means no controller has to remember.
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return next.handle().pipe(
      map((payload) => {
        const serialised = serialise(payload);
        if (raw || serialised === undefined || serialised === null) return serialised;

        // A handler that already returns `{ data, meta }` (paginated lists)
        // is passed through rather than double-wrapped.
        if (isEnvelope(serialised)) return serialised;

        return { data: serialised };
      }),
    );
  }
}

const isEnvelope = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'data' in value;

/**
 * Recursively converts Decimal → string, BigInt → string, Date → ISO 8601.
 * Everything else is returned untouched.
 */
export function serialise(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Prisma.Decimal.isDecimal(value)) {
    // Fixed 4 dp matches the canonical Money wire form.
    return (value as Prisma.Decimal).toFixed(4);
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');

  if (Array.isArray(value)) return value.map(serialise);

  if (typeof value === 'object') {
    // Leave class instances that define their own serialisation alone.
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = serialise(item);
    return output;
  }

  return value;
}
