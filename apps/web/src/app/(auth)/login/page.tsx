'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginDto } from '@hixaa/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError, api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginDto>({
    // The SAME schema the API validates against. A rule cannot be enforced on
    // one side and not the other — that is the point of @hixaa/contracts.
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: false },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/auth/login', values);
      // Effective permissions come from /auth/me; drop anything cached under a
      // previous identity before navigating.
      queryClient.removeQueries({ queryKey: queryKeys.auth.me() });
      router.replace(params.get('next') ?? '/dashboard');
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        for (const [field, message] of Object.entries(error.fieldErrors)) {
          setError(field as keyof LoginDto, { message });
        }
        setFormError(error.problem.detail);
      } else {
        setFormError('Could not reach the server. Please try again.');
      }
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {formError ? (
        // aria-live so a screen reader announces the failure rather than
        // leaving the user wondering why nothing happened.
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{formError}</span>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          autoFocus
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
          {...register('email')}
        />
        {errors.email ? (
          <p id="email-error" className="text-xs text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? 'password-error' : undefined}
          {...register('password')}
        />
        {errors.password ? (
          <p id="password-error" className="text-xs text-destructive">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input accent-[hsl(var(--primary))]"
            {...register('rememberMe')}
          />
          Remember me for 30 days
        </label>
        <a href="/forgot-password" className="rounded text-sm text-primary hover:underline">
          Forgot password?
        </a>
      </div>

      <Button type="submit" className="w-full" loading={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold tracking-tight text-primary">HIXAA</div>
          <p className="mt-1 text-xs text-muted-foreground">Distributor Management System</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h1 className="mb-5 text-lg font-semibold">Sign in</h1>
          <Suspense
            fallback={
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-5 text-center text-xs text-muted-foreground">
          Hixaa Technologies Pvt. Ltd. · Nagpur
        </p>
      </div>
    </main>
  );
}
