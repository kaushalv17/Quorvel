import LegalPage, { H2, P } from '../_components/LegalPage'

export const metadata = {
  title: 'Refund and Cancellation Policy — Quorvel',
  description: 'Quorvel refund and cancellation terms for paid subscriptions.',
}

export default function RefundsPage() {
  return (
    <LegalPage
      title="Refund and Cancellation Policy"
      lastUpdated="24 June 2026"
      intro={
        <>
          We want Quorvel to be an easy yes. This policy explains our refund and cancellation
          terms for paid subscriptions.
        </>
      }
    >
      <H2>1. 14-day money-back guarantee</H2>
      <P>
        If you&rsquo;re not happy with your first paid Quorvel subscription, email us at
        hello@quorvel.tech within 14 days of your first payment and we&rsquo;ll refund it in full
        — no hard feelings.
      </P>

      <H2>2. Cancel anytime</H2>
      <P>
        You can cancel your subscription at any time from your dashboard or by emailing us. When
        you cancel, your plan stays active until the end of the billing period you&rsquo;ve
        already paid for, then automatically drops to the Free plan. You keep access to your
        data.
      </P>

      <H2>3. After the 14-day window</H2>
      <P>
        Outside the 14-day guarantee, payment for the current billing period is non-refundable,
        but you won&rsquo;t be charged again after you cancel. We bill monthly (not annually), so
        you&rsquo;re never locked into a long commitment.
      </P>

      <H2>4. How refunds are processed</H2>
      <P>
        Because Paddle is our Merchant of Record, approved refunds are issued through Paddle back
        to your original payment method. Refunds typically appear within 5–10 business days,
        depending on your bank or card issuer.
      </P>

      <H2>5. Exceptions and special cases</H2>
      <P>
        If you were charged in error, billed twice, or couldn&rsquo;t access the Service due to an
        outage on our side, contact us — we&rsquo;ll make it right regardless of the 14-day
        window.
      </P>

      <H2>6. Enterprise plans</H2>
      <P>
        Custom Enterprise agreements may have their own refund and cancellation terms, as set out
        in the applicable order form or contract.
      </P>

      <H2>7. How to request a refund</H2>
      <P>
        Email hello@quorvel.tech from your account email with your account details and a short
        note. We&rsquo;ll confirm within 2 business days.
      </P>

      <H2>8. Contact</H2>
      <P>hello@quorvel.tech</P>
    </LegalPage>
  )
}
