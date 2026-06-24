import LegalPage, { H2, P, Ul, Li } from '../_components/LegalPage'

export const metadata = {
  title: 'Terms of Service — Quorvel',
  description: 'The terms that govern your use of Quorvel.',
}

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      lastUpdated="24 June 2026"
      intro={
        <>
          These Terms of Service (“Terms”) are a legal agreement between you and Quorvel
          (“Quorvel”, “we”, “us”). They govern your access to and use of the Quorvel website,
          SDK, API, and hosted dashboard (together, the “Service”). By creating an account,
          joining the waitlist, or using the Service, you agree to these Terms.
        </>
      }
    >
      <H2>1. Who we are</H2>
      <P>
        Quorvel is an independent software product operated as a sole proprietorship based in
        India. You can reach us any time at hello@quorvel.tech.
      </P>

      <H2>2. The Service</H2>
      <P>
        Quorvel is a reliability layer for AI agents. It provides a durable action ledger,
        exactly-once execution, human-in-the-loop approvals, automatic recovery, and real-time
        alerts, delivered through our open-source SDK, hosted API, and dashboard. The Service is
        in active early-stage development (“v0.1”) and is offered on an as-is basis.
      </P>

      <H2>3. Eligibility and accounts</H2>
      <P>
        You must be at least 18 years old to use the Service. You are responsible for
        safeguarding your API keys and for all activity that occurs under your account or keys.
        Notify us promptly at hello@quorvel.tech if you suspect any unauthorized use.
      </P>

      <H2>4. Acceptable use</H2>
      <P>You agree not to:</P>
      <Ul>
        <Li>use the Service for any unlawful purpose or to violate the rights of others;</Li>
        <Li>attempt to breach or circumvent the security of the Service;</Li>
        <Li>resell, sublicense, or provide the hosted Service to third parties without our permission;</Li>
        <Li>store or transmit unlawful, harmful, or infringing content; or</Li>
        <Li>abuse, overload, or exceed your plan limits through automated or deceptive means.</Li>
      </Ul>

      <H2>5. Plans and billing</H2>
      <P>
        The Service is offered on Free, Pro ($29/month), Scale ($99/month), and Enterprise
        (custom) plans. Paid plans are billed monthly in advance in US dollars. Usage above your
        plan&rsquo;s included quota is billed as overage at the rates shown on our pricing page.
        Plan features and prices may change; we&rsquo;ll give reasonable notice of material
        changes.
      </P>

      <H2>6. Payments and Merchant of Record</H2>
      <P>
        Our order process and payments are handled by our payment partner, Paddle
        (Paddle.com Market Ltd), which acts as the Merchant of Record for all purchases. Paddle
        handles billing, payment processing, and applicable sales tax, VAT, or GST, and issues
        your receipt. Your purchase is therefore also subject to Paddle&rsquo;s Buyer Terms and
        Privacy Policy.
      </P>

      <H2>7. Cancellation and refunds</H2>
      <P>
        You can cancel at any time. We offer a 14-day money-back guarantee on your first paid
        subscription. Full details are in our Refund and Cancellation Policy.
      </P>

      <H2>8. Your data and content</H2>
      <P>
        You retain all rights to the data you send to the Service. You grant us a limited license
        to process that data solely to operate the Service — to record, dedupe, gate, recover,
        and alert on your actions. Our handling of data is described in our Privacy Policy.
      </P>

      <H2>9. Intellectual property</H2>
      <P>
        The Quorvel SDK is open source under the MIT License. The hosted Service, dashboard,
        website, the “Quorvel” name, and our logo are our property. These Terms do not grant you
        any right to use our trademarks.
      </P>

      <H2>10. Availability and changes</H2>
      <P>
        We aim for high availability, but the Service is provided “as is” and “as available,”
        without an uptime guarantee on the Free tier. We may modify, suspend, or discontinue
        features, particularly during this early-access period.
      </P>

      <H2>11. Disclaimers</H2>
      <P>
        To the maximum extent permitted by law, the Service is provided without warranties of any
        kind, express or implied. We do not warrant that the Service will be uninterrupted,
        error-free, or fit for a particular purpose.
      </P>

      <H2>12. Limitation of liability</H2>
      <P>
        To the fullest extent permitted by law, Quorvel will not be liable for any indirect,
        incidental, special, or consequential damages, or for lost profits or data. Our total
        aggregate liability for any claim is limited to the amount you paid us in the three (3)
        months before the event giving rise to the claim.
      </P>

      <H2>13. Indemnification</H2>
      <P>
        You agree to indemnify and hold Quorvel harmless from any claims arising out of your
        misuse of the Service or your violation of these Terms.
      </P>

      <H2>14. Termination</H2>
      <P>
        We may suspend or terminate your access if you breach these Terms or use the Service in a
        way that risks harm to others or to the Service. You may stop using the Service at any
        time.
      </P>

      <H2>15. Governing law</H2>
      <P>
        These Terms are governed by the laws of India, without regard to conflict-of-law rules,
        and the courts of India will have jurisdiction — subject to any mandatory
        consumer-protection rights you have in your country of residence.
      </P>

      <H2>16. Changes to these Terms</H2>
      <P>
        We may update these Terms from time to time. Material changes are reflected by the
        “Last updated” date above and, where appropriate, notified by email.
      </P>

      <H2>17. Contact</H2>
      <P>Questions about these Terms? Email hello@quorvel.tech.</P>
    </LegalPage>
  )
}
