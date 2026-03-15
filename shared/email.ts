/**
 * Email module — sends transactional email via Resend API.
 *
 * Production guard: Throws at module load if RESEND_API_KEY is absent.
 * Development: Logs warning and returns graceful failure.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = "APIMesh <noreply@apimesh.xyz>";
const RESEND_API_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 5000;

// Startup guard
if (process.env.NODE_ENV === "production" && !RESEND_API_KEY) {
  throw new Error(
    "RESEND_API_KEY is required in production. Set it in your environment."
  );
}

if (!RESEND_API_KEY) {
  console.warn(
    "[email] RESEND_API_KEY not configured — emails will not be sent in development."
  );
}

export interface EmailResult {
  success: boolean;
  error?: string;
}

/**
 * Send an email via Resend API with 5s timeout and 1 retry on 5xx/timeout.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<EmailResult> {
  if (!RESEND_API_KEY) {
    return { success: false, error: "RESEND_API_KEY not configured" };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [to],
          subject,
          html,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.ok) {
        return { success: true };
      }

      // Retry on 5xx
      if (response.status >= 500 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const body = await response.text().catch(() => "");
      return {
        success: false,
        error: `Resend API error ${response.status}: ${body}`,
      };
    } catch (err) {
      // Retry on timeout/network error (first attempt only)
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return {
        success: false,
        error: `Email send failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, error: "Email send failed after retries" };
}

/**
 * Send a 6-digit verification code email.
 */
export async function sendVerificationCode(
  to: string,
  code: string
): Promise<EmailResult> {
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Verify your email</h2>
      <p>Your verification code is:</p>
      <div style="background: #f0f0f5; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1a1a2e;">${code}</span>
      </div>
      <p style="color: #666;">This code expires in <strong>10 minutes</strong>.</p>
      <p style="color: #999; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
  return sendEmail(to, "APIMesh - Verify your email", html);
}

/**
 * Send a password reset code email.
 */
export async function sendPasswordResetCode(
  to: string,
  code: string
): Promise<EmailResult> {
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Reset your password</h2>
      <p>Your password reset code is:</p>
      <div style="background: #f0f0f5; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1a1a2e;">${code}</span>
      </div>
      <p style="color: #666;">This code expires in <strong>10 minutes</strong>.</p>
      <p style="color: #999; font-size: 12px;">If you didn't request a password reset, your account is safe. No action needed.</p>
    </div>
  `;
  return sendEmail(to, "APIMesh - Password Reset", html);
}

/**
 * Send a low balance alert email.
 */
export async function sendLowBalanceAlert(
  to: string,
  balance: number,
  threshold: number
): Promise<EmailResult> {
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #e74c3c;">Low Balance Alert</h2>
      <p>Your APIMesh credit balance has dropped below your alert threshold.</p>
      <div style="background: #fef3f3; border: 1px solid #e74c3c; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <p style="margin: 0;"><strong>Current balance:</strong> $${(balance / 1_000_000).toFixed(2)}</p>
        <p style="margin: 8px 0 0 0;"><strong>Alert threshold:</strong> $${(threshold / 1_000_000).toFixed(2)}</p>
      </div>
      <p>Add credits to your account to avoid service interruption.</p>
      <p style="color: #999; font-size: 12px;">You can adjust your alert threshold in the APIMesh dashboard.</p>
    </div>
  `;
  return sendEmail(to, "APIMesh - Low Balance Alert", html);
}
