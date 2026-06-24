import LegalPage, { H2, P, Ul, Li } from '../_components/LegalPage'

export const metadata = {
  title: 'Privacy Policy — Quorvel',
  description: 'What data Quorvel collects, how we use it, and your choices.',
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lastUpdated="24 June 2026"
      intro={
        <>
          This Privacy Policy explains what information Quorvel collects, how we use it, and the
          choices you have. It applies to our website, SDK, API, and dashboard.
        </>
      }
    >
      <H2>1. Who we are</H2>
      <P>
        Quorvel is an independent business based in India and is the controller of the personal
        data described here. Contact us at hello@quorvel.tech.
      </P>

      <H2>2. Information we collect</H2>
      <Ul>
        <Li><strong>Account information</strong> — your email address, basic profile, and API keys.</Li>
        <Li>
          <strong>Action metadata</strong> — when you use the ledger, we store the metadata you
          send: action names, the inputs and outputs you choose to log, status, idempotency keys,
          timestamps, and approval decisions.
        </Li>
        <Li>
          <strong>Billing information</strong> — handled by Paddle. We receive limited details
          (plan, country, last four digits, transaction IDs) but never your full card number.
        </Li>
        <Li><strong>Usage data</strong> — logs, IP address, and device/browser information, used for security and reliability.</Li>
        <Li><strong>Communications</strong> — emails and waitlist sign-ups you send us.</Li>
      </Ul>

      <H2>3. How we use your information</H2>
      <P>
        We use this data to operate and secure the Service; to record, dedupe, gate, recover, and
        alert on your actions; to provide support; to process billing through Paddle; to send
        essential service notices and, if you opt in, product updates; and to comply with the
        law.
      </P>

      <H2>4. What we never do</H2>
      <P>
        We never sell your data. We never use your data to train AI or machine-learning models.
        We never share your action data with other customers.
      </P>

      <H2>5. Sub-processors</H2>
      <P>We rely on a small set of trusted providers to run the Service:</P>
      <Ul>
        <Li>Vercel — website and front-end hosting</Li>
        <Li>Render — API hosting</Li>
        <Li>Neon — managed PostgreSQL database</Li>
        <Li>Upstash — managed Redis for queues and alerts</Li>
        <Li>Paddle — payments and Merchant of Record</Li>
        <Li>Zoho Mail — business email</Li>
        <Li>Formspree — waitlist form handling</Li>
      </Ul>
      <P>Each processes data only as needed to provide its service to us.</P>

      <H2>6. Security</H2>
      <P>
        Data is encrypted in transit (TLS) and at rest. You can choose your data region, or
        self-host the ledger in your own VPC on eligible plans. We apply least-privilege access
        internally.
      </P>

      <H2>7. Data retention</H2>
      <P>
        Action history is retained according to your plan (for example, 7 days on Free, 90 days
        on Pro, and 1 year on Scale). You can export or request deletion of your data at any
        time. We delete account data within 30 days of account closure, except where we must
        retain records for legal or accounting reasons.
      </P>

      <H2>8. Your rights</H2>
      <P>
        Depending on where you live, you may have rights to access, correct, export, or delete
        your personal data, and to object to or restrict certain processing. To exercise these
        rights, email hello@quorvel.tech.
      </P>

      <H2>9. Cookies</H2>
      <P>
        Our website uses minimal, essential cookies. We keep analytics light and do not use
        invasive cross-site advertising trackers.
      </P>

      <H2>10. International transfers</H2>
      <P>
        We may process data in countries other than yours. Where required, we use appropriate
        safeguards for those transfers.
      </P>

      <H2>11. Children</H2>
      <P>
        The Service is not directed to anyone under 18, and we do not knowingly collect data from
        children.
      </P>

      <H2>12. Changes to this policy</H2>
      <P>
        We will update this policy as the Service evolves; the “Last updated” date reflects the
        latest version.
      </P>

      <H2>13. Contact</H2>
      <P>Privacy questions? Email hello@quorvel.tech.</P>
    </LegalPage>
  )
}
