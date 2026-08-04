import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { ValidationError } from '../errors/domain.error';
import { zodToFieldErrors } from '../filters/all-exceptions.filter';

/**
 * Validates a request payload against a Zod schema from @hixaa/contracts.
 *
 * This is the mechanism that makes ADR-0001 real: the schema validating a
 * request here is the same object generating the OpenAPI definition and driving
 * the frontend's React Hook Form resolver. There is one rule, so client and
 * server cannot disagree.
 *
 * Zod strips unknown properties by default, which also means mass-assignment
 * is not possible — a caller cannot smuggle `isSystem: true` into a create DTO.
 */
/**
 * The input type is intentionally loose (`any`).
 *
 * Schemas with `.default()` or `.transform()` — every list query has both —
 * have an input type that differs from their output. Pinning input to the
 * output type would reject exactly the schemas this pipe exists to serve.
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly schema: ZodType<TOutput, ZodTypeDef, any>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): TOutput {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError('One or more fields are invalid.', zodToFieldErrors(error));
      }
      throw error;
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `@Body(zodBody(createUserSchema))` */
export const zodBody = <T>(schema: ZodType<T, ZodTypeDef, any>) => new ZodValidationPipe(schema);

/** `@Query(zodQuery(listUsersSchema))` */
export const zodQuery = <T>(schema: ZodType<T, ZodTypeDef, any>) => new ZodValidationPipe(schema);

/** `@Param(zodParam(idParamSchema))` */
export const zodParam = <T>(schema: ZodType<T, ZodTypeDef, any>) => new ZodValidationPipe(schema);
