/**
 * The weekly strategist's rules (owner decision 2026-11-16; the review's "one binding constraint at the top of the Monday scorecard").
 *
 * Pure. The week's funnel for CareMetric Intel goes in (private.growth_strategy_facts, counts only); out come the candidate binding
 * constraints, each scored 0 to 100 from the figures alone, with the figures behind it and a move written by code. The model picks one
 * and says it better; when it cannot, the top candidate goes as written here. A candidate never appears without the figures that make it
 * one, so the strategist can only name a constraint the week shows.
 *
 * The funnel, in order: agencies found (roster, discovery) → strong fits with an address the team may write to → addresses that are
 * deliverable → first emails sent (the daily cap) → read and answered (report opens, replies) → trials → activated trials → paying. Two
 * things can hold any stage: the Marketing Manager's daily budget and the owner's own approvals.
 */

export const strategistVersion = 'strategist.1';

/** The constraints the strategist can name, in funnel order, with the label the scorecard shows. */
export const constraintLabels = Object.freeze({
  deliverability: 'Email is bouncing',
  supply: 'Too few agencies ready to write to',
  reach: 'Strong fits with no address',
  permission: 'Addresses waiting for your permission',
  volume: 'The daily cold-email cap',
  engagement: 'First emails are not read or answered',
  conversion: 'Interest is not becoming trials',
  activation: 'Trials are not reaching first value',
  budget: 'The Marketing Manager\'s daily budget',
  approvals: 'Proposals waiting for you',
});

/** The figures a move can be judged by next Monday. */
export const watchLabels = Object.freeze({
  bounceRate: 'hard bounces as a share of cold emails sent',
  ready: 'strong fits ready for a first email',
  strongNoContact: 'strong fits with no usable address',
  awaitingPermission: 'strong fits whose address is waiting for your permission',
  firstSent: 'first emails sent',
  openRate: 'agencies that opened their report, per first email delivered',
  replies: 'replies',
  trialStarts: 'trial starts',
  activated: 'activated trials',
  budgetDays: 'days the Marketing Manager ran out of budget',
  approvals: 'proposals waiting for you',
});

const n = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);
const pct = (part, whole) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
const clamp = value => Math.max(0, Math.min(100, Math.round(value)));

/** The week's figures as the rules and the model read them: whole numbers and whole percents only. */
export function weekFigures(facts) {
  const e = facts?.email ?? {}, p = facts?.prospects ?? {}, c = facts?.conversion ?? {}, s = facts?.spend ?? {};
  // Cold emails attempted in the week, counted by message as the bounce guard counts them; delivery events can lag or be missing.
  const sent = Math.max(n(e.sent), n(e.delivered) + n(e.bounced));
  return {
    strong: n(p.strong), ready: n(p.strongReachable), strongNoContact: n(p.strongNoContact), awaitingPermission: n(p.strongAwaitingPermission), briefed: n(p.briefed),
    rosterOpen: n(facts?.roster?.unresolved), rosterResolved: n(facts?.roster?.resolvedInWeek),
    checked: n(facts?.addresses?.checked), unanswered: n(facts?.addresses?.unanswered),
    firstSent: n(e.firstSent), followups: n(e.followups), sent, delivered: n(e.delivered), bounced: n(e.bounced), bounceRate: pct(n(e.bounced), sent),
    complaints: n(e.complaints), replies: n(e.replies), reportViews: n(e.reportViews), openRate: pct(n(e.reportViews), n(e.firstSent)),
    capDays: n(e.capDays), cap: n(facts?.settings?.coldEmailCap), waiting: n(e.approvedWaiting ?? e.waiting),
    limitDays: n(e.limitDays), productLimit: n(facts?.settings?.productDailyLimit),
    trialStarts: n(c.trialStarts), activated: n(c.activated), paid: n(c.paid),
    spendDollars: Math.round(n(s.marketingCents) / 100), budgetDollars: Math.round(n(s.budgetCents) / 100), budgetDays: n(s.budgetDays),
    approvals: n(facts?.approvals),
    // The bounce guard's own window (since the owner last saved it or resumed): cold emails sent and hard bounces.
    guardSent: facts?.guard?.on ? n(facts.guard.sent) : 0, guardBounced: facts?.guard?.on ? n(facts.guard.bounced) : 0,
  };
}

/** The figures that are counts of the week itself; the others (strong fits, drafts waiting, approvals, the cap) are as of the read. */
export const snapshotFigures = Object.freeze(['strong', 'ready', 'strongNoContact', 'awaitingPermission', 'rosterOpen', 'waiting', 'cap', 'productLimit', 'approvals', 'budgetDollars', 'guardSent', 'guardBounced']);
export const weekOnly = figures => Object.fromEntries(Object.entries(figures).filter(([key]) => !snapshotFigures.includes(key)));

/**
 * The candidates for the week, most binding first. Each: { key, score, evidence, headline, move, watch }. `previous` is the week before
 * (its figures make "two weeks running" possible); either may be missing. Below 20 a candidate is not offered.
 */
export function candidates(facts, previous = null) {
  const f = weekFigures(facts);
  const before = previous ? weekFigures(previous) : null;
  const twoWeeksSent = f.sent + (before?.sent ?? 0);
  const list = [];
  const add = (key, score, evidence, headline, move, watch) => { if (score >= 20) list.push({ key, score: clamp(score), evidence, headline, move, watch }); };

  // Mailbox providers judge a sender by complaints and hard bounces before anything else: nothing below matters while they are high.
  if (f.complaints > 0) {
    add('deliverability', 100, { complaints: f.complaints, sent: f.sent },
      `${f.complaints === 1 ? 'Someone' : `${f.complaints} people`} marked a cold email as spam last week.`,
      'Hold the cap where it is, read the complaint on Growth, and set "Check an address before the first email" to Strict until a clean week.', 'bounceRate');
  } else if (f.sent >= 10 && f.bounceRate >= 2) {
    // Bounces the bounce guard's own window no longer shows (at least 10 sent since, under 2% bounced) weigh half: the week's bounces
    // came before the owner switched the checks on.
    const since = f.guardSent >= 10 && f.guardBounced * 100 < 2 * f.guardSent;
    add('deliverability', (f.bounceRate >= 5 ? 90 : 60) / (since ? 2 : 1),
      { bounced: f.bounced, sent: f.sent, bounceRate: f.bounceRate, rule: 2, ...(f.guardSent ? { guardSent: f.guardSent, guardBounced: f.guardBounced } : {}) },
      `${f.bounced} of ${f.sent} cold emails bounced for good (${f.bounceRate}%), above the 2% rule for raising the cap${since ? `; ${f.guardBounced} of the ${f.guardSent} sent since the bounce guard's window began did` : ''}.`,
      'Keep "Most cold emails a day" where it is and confirm the sending domain\'s SPF, DKIM and DMARC records before sending more.', 'bounceRate');
  }
  // Nothing to send: the agencies ready for a first email ran out.
  if (f.waiting === 0 && f.ready < 10) {
    add('supply', f.ready === 0 ? 85 : 75 - f.ready * 3, { ready: f.ready, waiting: f.waiting, rosterOpen: f.rosterOpen, rosterResolved: f.rosterResolved },
      `Only ${f.ready} strong-fit ${f.ready === 1 ? 'agency was' : 'agencies were'} ready for a first email, and none was waiting.`,
      f.rosterOpen > 0 ? `Raise "Roster agencies resolved a day": ${f.rosterOpen} roster agencies still have no confirmed website.`
        : 'Widen discovery to the next state the roster covers.', 'ready');
  }
  // Strong fits the team cannot write to because no address was found: more address checks can help these.
  if (f.strong >= 10) {
    const share = pct(f.strongNoContact, f.strong);
    add('reach', share >= 50 ? 40 + share / 2 : share, { strong: f.strong, strongNoContact: f.strongNoContact, share },
      `${f.strongNoContact} of ${f.strong} strong-fit agencies (${share}%) have no address the team may write to.`,
      'Raise "Most address checks a day" so the people finder tries more decision-makers per agency.', 'strongNoContact');
  }
  // Strong fits whose address was found and waits for your permission: the people finder no longer looks past it, so only your
  // decision (or handing named contacts over to the team) moves them.
  if (f.awaitingPermission >= 5) {
    const share = pct(f.awaitingPermission, Math.max(f.strong, 1));
    add('permission', 40 + Math.min(share, 50), { strong: f.strong, awaitingPermission: f.awaitingPermission, share },
      `${f.awaitingPermission} strong-fit ${f.awaitingPermission === 1 ? 'agency has an address' : 'agencies have an address'} waiting for your permission.`,
      'Decide the addresses waiting on Growth, or hand named contacts over to the team on the AI team page.', 'awaitingPermission');
  }
  // A daily limit held sending back on most days while approved drafts waited and bounces stayed low. Two limits apply: Intel's own
  // "Maximum messages per day" (Growth), which the send claim checks first, and the cold-email cap shared with CareBase. Each is judged
  // by the days it was itself reached; the one reached on more days (on a tie, the lower) is raised, and the other too only when it was
  // also reached on most days. The settings stop at 100.
  const capHeld = f.capDays >= 4 && f.cap > 0, productHeld = f.productLimit > 0 && f.limitDays >= 4;
  if ((capHeld || productHeld) && f.waiting >= 5 && f.sent >= 20 && f.bounceRate < 2 && f.complaints === 0) {
    const product = productHeld && (!capHeld || f.limitDays > f.capDays || (f.limitDays === f.capDays && f.productLimit <= f.cap));
    const limit = product ? f.productLimit : f.cap, days = product ? f.limitDays : f.capDays;
    if (limit < 100) {
      const next = Math.min(100, Math.max(limit + 5, Math.min(limit * 2, 25)));
      const capMove = `"Most cold emails a day" (Settings → Customer growth) from ${f.cap} to ${next}`;
      const productMove = `Intel's "Maximum messages per day" (Growth) from ${f.productLimit} to ${next}`;
      const raises = product ? [productMove, ...(capHeld && f.cap < next ? [capMove] : [])] : [capMove, ...(productHeld && f.productLimit < next ? [productMove] : [])];
      add('volume', 50 + days * 5, { capDays: f.capDays, limitDays: f.limitDays, cap: f.cap, productLimit: f.productLimit, waiting: f.waiting, bounceRate: f.bounceRate, suggestedCap: next },
        `${product ? `Intel's own limit of ${f.productLimit} emails a day` : `The cold-email cap of ${f.cap} a day`} was reached on ${days} of 7 days with ${f.waiting} approved drafts waiting and ${f.bounceRate}% bounces.`,
        `Raise ${raises.join(' and ')}.`, 'firstSent');
    }
  }
  // Delivered but not read or answered: the message, not the list. Judged over two weeks, sends, replies and opens alike, so one quiet
  // week is not called a pattern. While report opens are not recorded (Settings → Customer growth), none is counted, which is not zero
  // opens: the rule then rests on replies alone and says opens are unknown.
  const firstTwoWeeks = f.firstSent + (before?.firstSent ?? 0), viewsTwoWeeks = f.reportViews + (before?.reportViews ?? 0);
  const openTwoWeeks = pct(viewsTwoWeeks, firstTwoWeeks);
  const opensKnown = facts?.settings?.reportViews !== false;
  if (twoWeeksSent >= 30 && f.replies + (before?.replies ?? 0) === 0 && (!opensKnown || openTwoWeeks < 10)) {
    add('engagement', 55 + Math.min(twoWeeksSent, 100) / 5,
      opensKnown ? { sentTwoWeeks: twoWeeksSent, firstTwoWeeks, replies: 0, reportViewsTwoWeeks: viewsTwoWeeks, openRateTwoWeeks: openTwoWeeks } : { sentTwoWeeks: twoWeeksSent, replies: 0 },
      opensKnown ? `${twoWeeksSent} cold emails in two weeks drew no reply, and ${viewsTwoWeeks} ${viewsTwoWeeks === 1 ? 'agency' : 'agencies'} opened its report.`
        : `${twoWeeksSent} cold emails in two weeks drew no reply; report opens are not being recorded, so whether they were read is unknown.`,
      opensKnown ? 'Read the reader\'s weakest sentences on Growth and change the first email\'s offer, not its wording.'
        : 'Turn on recording report opens (Settings → Customer growth), and read the reader\'s weakest sentences on Growth.', opensKnown ? 'openRate' : 'replies');
  }
  // Interest without trials.
  if ((f.replies >= 2 || (opensKnown && f.reportViews >= 5)) && f.trialStarts === 0) {
    add('conversion', 55 + Math.min(f.replies * 5 + f.reportViews, 30), { replies: f.replies, reportViews: f.reportViews, trialStarts: 0 },
      `${f.replies} ${f.replies === 1 ? 'reply' : 'replies'} and ${f.reportViews} report ${f.reportViews === 1 ? 'open' : 'opens'} last week, and no trial started.`,
      'Make the second email to agencies that opened their report a direct trial offer with one step.', 'trialStarts');
  }
  // Trials that never reach first value.
  if (f.trialStarts + (before?.trialStarts ?? 0) >= 2 && f.activated + (before?.activated ?? 0) === 0) {
    add('activation', 70, { trialStarts: f.trialStarts + (before?.trialStarts ?? 0), activated: 0 },
      `${f.trialStarts + (before?.trialStarts ?? 0)} trials started in two weeks and none reached first value.`,
      'Have the Account Manager call or email each new trial on day one with the one report that shows their county.', 'activated');
  }
  if (f.budgetDays >= 3) {
    add('budget', 45 + f.budgetDays * 5, { budgetDays: f.budgetDays, budgetDollars: f.budgetDollars, spendDollars: f.spendDollars },
      `The Marketing Manager ran out of its $${f.budgetDollars} daily budget on ${f.budgetDays} of 7 days.`,
      'Raise the Marketing Manager\'s daily budget on the AI team page, or lower "Account briefs a day".', 'budgetDays');
  }
  if (f.approvals >= 10) {
    add('approvals', 40 + Math.min(f.approvals, 40), { approvals: f.approvals },
      `${f.approvals} proposals were waiting for you at the end of the week.`,
      'Clear the approvals queue, or let the kinds you always approve go on their own on the AI team page.', 'approvals');
  }
  return list.sort((a, b) => b.score - a.score || Object.keys(constraintLabels).indexOf(a.key) - Object.keys(constraintLabels).indexOf(b.key));
}

/** Every number the model may write: the week's figures, the week before's, the candidates' evidence and any `extra` it was given. */
export function allowedNumbers(facts, previous, list, extra = []) {
  const values = new Set([7, ...extra.filter(Number.isFinite)]);
  for (const figures of [weekFigures(facts), previous ? weekFigures(previous) : null]) for (const value of Object.values(figures ?? {})) values.add(value);
  for (const candidate of list) for (const value of Object.values(candidate.evidence)) if (Number.isFinite(value)) values.add(value);
  return values;
}

/** Why a text may not go: a number not in the figures, an address, a link or a person's name prefix. Null when it may. */
export function textProblem(text, numbers) {
  const value = String(text ?? '');
  if (/@|https?:\/\/|www\./i.test(value)) return 'contact_detail';
  if (/\b(?:Mr|Mrs|Ms|Dr)\.\s/.test(value)) return 'personal_information';
  for (const match of value.replace(/(\d),(\d{3})\b/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g)) if (!numbers.has(Number(match[0]))) return 'unlisted_number';
  return null;
}
