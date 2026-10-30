import { z } from 'zod';

/** Admin roles. Mirrors the `AdminRole` enum in the Prisma schema. */
export const adminRoleSchema = z.enum(['SUPER_ADMIN', 'EDITOR']);

export type AdminRole = z.infer<typeof adminRoleSchema>;

/** Body of POST /api/admin/auth/login. Email is normalised; the password is used as typed. */
export const loginBodySchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
});

export type LoginBody = z.infer<typeof loginBodySchema>;

/** The signed-in admin as returned by the API. Never includes hashes or lockout state. */
export const adminProfileSchema = z.strictObject({
  id: z.uuid(),
  email: z.email().max(254),
  name: z.string().min(1).max(100),
  role: adminRoleSchema,
  mustChangePassword: z.boolean(),
});

export type AdminProfile = z.infer<typeof adminProfileSchema>;

/** Response body wrapping the current admin, e.g. after login or from the "me" endpoint. */
export const adminProfileResponseSchema = z.strictObject({
  admin: adminProfileSchema,
});

export type AdminProfileResponse = z.infer<typeof adminProfileResponseSchema>;

/** Response body of GET /api/admin/auth/csrf. Send the token back in the CSRF header. */
export const csrfTokenResponseSchema = z.strictObject({
  csrfToken: z.string().min(1),
});

export type CsrfTokenResponse = z.infer<typeof csrfTokenResponseSchema>;
