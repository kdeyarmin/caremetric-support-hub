# PennSync learning migration and delivery contract

Status: implementation in progress. A preserved source is not a published course.

The source envelope remains `pennsync.learning-source.v1`. The new private course
document is `caremetric.learning-document.v2`; existing documents without this
contract retain their existing parser, grading, certificate, and enrollment
behavior. The current source is never rewritten during conversion.

## Ownership and releases

This lane owns PennSync import conversion, v2 assessment and lesson schemas,
the learner player/API extensions, and the Base44 grading adapter. The release
coordinator owns production SQL application. Shared HTTP, Docker and backend
feature integration is additive and rebased after other Hub releases.

1. Preserve the exact source and privately review conversion and blockers.
2. Add the v2 writer, learner runtime and a bounded grading provider.
3. Verify the current source, audience mappings, clinical approval, provider
   availability, media and course policies before publishing any imported course.
4. Activate PennSync's central-learning entry point after the complete path works.

## Immutable course document

Each converted course binds the source snapshot hash, course ID and record
revision. Lesson and question IDs derive deterministically from their original
entity IDs. The [bulk media import](MEDIA_IMPORT.md) relies on this: a manifest row
that names a TrainingModule id attaches its approved video to the draft lesson with
that derived id, so a Hub draft of a converted course must keep it. Option IDs derive from the original option value, after the same
case/whitespace normalization used by PennSync. Ambiguous normalized options
block conversion; they are never merged. The original fields remain in the
private source snapshot, including unmapped learners and plan relationships.

The document contains ordered structured lessons (intro, sections, examples,
bullets, procedures, case scenarios, self-checks, clinical pearls and takeaways),
audience and clinical-review metadata, and one course-level assessment. A missing
lesson body, inactive question bank, malformed policy, untransferred material or
unsupported source structure blocks publication. No placeholder lesson is made.

Question kinds are single choice, multiple choice, true/false, matching, short
answer and scenario response. The private key is a set of option IDs, a matching
map or a Base44 grading reference. Learner documents explicitly project only
prompts, options, left-side matching prompts and point weights. They never include
keys, rubrics, provider tickets, learner identities or raw source records.

## Assessment and completion policy

Preserve the course pass floor and weighted score, the finite/unlimited attempt
limit, retake cooldown, question/option randomization, reshuffling on retake,
answer-disclosure setting, mandatory signed attestation and exact statement hash.
An assignment may strengthen the course gates, never weaken them. Persist actual
question/option order with each attempt. Use PennSync's rounded weighted percent.

Objective answers are graded on the server. Freeform answers use the established
Base44 Core InvokeLLM educator rubric through a provider interface. Provider
failure, malformed/partial results or a source revision mismatch must consume no
attempt and issue no certificate. There is no fallback to guessed grades or to a
different vendor. Test provider behavior with synthetic fixtures, not paid
production grading calls.

The new Hub writer reserves a request-key-bound attempt under a row lock before
external I/O, then verifies learner, tenant, immutable version, current entitlement,
session, answer hash, attestation and lease again before committing. Concurrent
submissions cannot exceed attempt limits or double-complete. Retry of an identical
request returns the original result; a changed payload with that key conflicts.

Certificate-enabled and disabled completions remain distinct. A certificate
records the course revision, score, signed attestation and original wording;
calendar-month validity clamps month-end dates. Annual renewal creates a separate
cycle without modifying old evidence. Existing history is never attached to a
different learner because their name or email appears similar.

## Grading provider transport

The Hub and a new PennSync function share a new internal credential. No credential
is placed in Git, browser code or URLs. Only the fixed Hub callback and fixed
PennSync function origin are accepted, with redirects disabled. Browser Origin
requests are refused by the native function.

A short-lived, single-use ticket binds the reserved attempt, tenant, version,
answer hash, exact source question IDs/revisions, maximum points and deadline.
The native function consumes that ticket through the fixed callback, fetches the
source question itself and verifies its revision before grading. It accepts no
arbitrary prompt, rubric, vendor URL or model from the request. Results contain
exactly one bounded evaluation for each requested question and carry the attempt
binding. The Hub rechecks authorization and the lease before committing them.

The native function durably stores a validated result through a separate fixed
completion callback before returning it. A lost HTTP response is recovered from
that stored result without another paid grade. A dispatched request with no
confirmed outcome remains pending/unknown; lease expiry alone never authorizes
automatic paid redispatch. Callback capabilities are narrowly scoped to the
attempt and payload, and cannot create or alter learner submissions.

## Current source findings

The first preserved cohort contains 19 courses, 23 modules (six standalone), 55
questions, six plans, 48 plan-course links and 20 legacy history records. Sixteen
published courses contain lessons; two published shells and one draft have no
lessons. All six standalone modules have no stored content. Seven published
courses contain nine AI-graded written-response questions. One legacy learner has
no registered-user match. One published course still requires clinical review.

The 18 annual courses specify pass 80%, three attempts, a 24-hour cooldown,
randomized questions and answers, reshuffling on retake, no answer disclosure,
required attestation, and a 12-month certificate. These are requirements to
preserve, not switches to clear to accelerate publication.

The medication-management source has an older `correct_answer_json.answer.value`
encoding. Only that exact one-key wrapper is decoded for objective questions;
the scalar or array must map unambiguously to actual options. Original source
bytes and revisions remain unchanged. The review carries an explicit answer-key
warning, together with the existing clinical-review requirement. The freeform
provider uses the original prompt and rubric; it does not interpret objective
answer keys or replace the Hub's objective grading.
