import { CircleHelp, LockKeyhole, Mail, Phone } from 'lucide-react';
import { config } from '../lib/config';

/** Shown where customers used to set up Hub accounts: the Hub is private to its owner, so they are pointed to support instead. */
export function PrivateHubNotice() {
  return <main className="mfa-page"><section className="mfa-panel">
    <div className="brand-lockup brand-lockup-large"><span className="brand-icon"><CircleHelp size={25} /></span><span><strong>CareMetric</strong><small>Support Hub</small></span></div>
    <div className="mfa-copy"><span className="eyebrow"><LockKeyhole size={13} /> Private</span><h1>This Hub is private.</h1>
      <p>Only the CareMetric owner signs in here. For help with CareBase, Breathe or Intel, contact CareMetric support.</p></div>
    <div className="sign-in-support" aria-label="Central support contacts"><a href={`tel:${config.centralSupportPhone}`}><Phone size={17} /><span><small>Call central support</small><strong>{config.centralSupportPhoneDisplay}</strong></span></a><a href={`mailto:${config.centralSupportEmail}`}><Mail size={17} /><span><small>Email central support</small><strong>{config.centralSupportEmail}</strong></span></a></div>
  </section></main>;
}
