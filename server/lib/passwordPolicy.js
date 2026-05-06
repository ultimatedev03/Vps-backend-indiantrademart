export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.';

export const validateStrongPassword = (value) => {
  const password = String(value || '');

  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: PASSWORD_POLICY_MESSAGE, code: 'MIN_LENGTH' };
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9\s]/.test(password);

  if (!hasUpper || !hasLower || !hasNumber || !hasSpecial) {
    return { ok: false, error: PASSWORD_POLICY_MESSAGE, code: 'WEAK_PASSWORD' };
  }

  return { ok: true, error: null, code: null };
};
