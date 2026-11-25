# Compliance — three licences, three different people

Everything in this document was read from the primary source, not from a summary. Dates and clause
numbers are given so you can check them yourself.

| instrument | governs | binds | changes if you fork it |
|---|---|---|---|
| MIT `LICENSE` | this repository's code | anyone who uses the code | no |
| MiniMax H3 Community License Agreement, 2 Aug 2026 | the video model and its outputs | whoever runs the model — i.e. **you**, the operator | no |
| Kaggle Terms of Use (22 Jun 2025) + Acceptable Use Policy | the compute | whoever owns the Kaggle account | no |

The distinction matters: MIT gives you everything in this repo. It gives you nothing about the model.
The model licence is between you and MiniMax. The compute terms are between you and Kaggle.

---

## 1. This repository — MIT

Fork it, sell it, host it, strip the branding off. There is no field-of-use restriction, because a
licence with one is not open source.

## 2. MiniMax H3 — Community License, 2 August 2026

Full text: <https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE>
Licensor: Nanonoble Pte. Ltd., Singapore ("MiniMax").

**This repository ships no weights.** The Kaggle kernel downloads them from the address above at run
time, under the terms of that agreement, for the person whose Kaggle account runs it. Mirroring or
bundling them would be a redistribution, and section III attaches conditions to that.

### Territory — §I.5, §II, §V.4

> I.5 "Excluded Territories" means the European Union, the United Kingdom, the Republic of Korea and
> the United States of America.

> §II Solely within the Applicable Territory, we grant you a non-exclusive, non-transferable,
> royalty-free, limited license to use, reproduce, distribute, create derivative works … and modify
> the Materials …

> §V.4 You may not use, reproduce, modify, distribute, or display the MiniMax H3 Works or any of their
> Outputs or results outside the Applicable Territory. Any such use outside the Applicable Territory is
> not authorized by this Agreement.

"Applicable Territory" is worldwide *minus* those four. Note what §V.4 covers: not just the model, but
**the videos it produces**. A render made in Cape Town and posted to an audience in Frankfurt is a
display outside the Applicable Territory.

### Attribution and marking — §IV.2, §III.3, §III.4

> §IV.2 You shall prominently display "MiniMax H3" on the user interface of commercial product or
> service that uses MiniMax H3 or MiniMax H3 Works.

> §III.3 You are encouraged to: a. display a notice … indicating that the product or service is
> "Powered by MiniMax H3"; b. add an AI-generation identifier to files produced using generative AI
> models including MiniMax H3; c. publish at least one technical blog post or a public statement …

> §III.4 All distributions to Third Parties … must be accompanied by a "NOTICE" text file containing
> the following notice: "MiniMax H3 is licensed under the MiniMax H3 Community License Agreement,
> Copyright © 2026 MiniMax. All Rights Reserved."

What this repo does, in the artifact rather than in a footnote:

- `MiniMax H3` appears on the setup panel and the studio footer (§IV.2);
- `Powered by MiniMax H3` sits in the footer of every screen (§III.3.a);
- every published mp4 is rewritten with `comment=MiniMax H3 …` plus the app name and version, so an
  AI-generation identifier travels inside the file (§III.3.b);
- `NOTICE` carries §III.4's sentence verbatim.

Not done, and you should: §III.3.c — publish something public about your experience. That is an
obligation of *your* use, not something a repository can do for you.

### Binding your users — §V.2

> §V.2 Before providing access to the MiniMax H3 Works or any product, service, or Hosted Service
> incorporating them, you must bind each recipient or user to enforceable terms at least as protective
> as the use restrictions in this Section V and Exhibit A, and you must notify each recipient or user
> that those restrictions apply.

This is why the setup is a hard server-side gate and not a checkbox. `data/setup.json` records the
licence version, the territory attestation and the timestamp before the studio route will answer at
all. A client-side-only modal would not satisfy §V.2, which is why the middleware exists.

If you hand a link to someone else, **you** are the one providing access, and §V.2 puts the binding
obligation on you. The setup screen in this app does that for the person at the keyboard; it cannot do
it for someone you send a video to.

### Commercial thresholds — §IV.1

> §IV.1 You shall obtain a separate, prior written authorization from MiniMax by contacting
> api@minimax.io with the subject line "MiniMax H3 licensing - authorization request", if your
> commercial products and services generate more than 20 million US dollars (or equivalent in other
> currencies) in yearly revenue.

### Other restrictions worth reading — §V.3, §V.5, §VI.3

- §V.3: outputs may not be used to improve any other AI model (distillation included).
- §V.5: if you make a product that lets third parties generate outputs, you must implement and
  maintain reasonable safeguards against uses that violate §V and Exhibit A.
- §VI.3: bringing an IP suit over the materials or outputs terminates your licence.
- §VI.4: MiniMax claims no rights over your outputs; you are responsible for them.
- Governing law is Hong Kong SAR.

Exhibit A of the same agreement adds a 20-item acceptable use policy — no use outside the territory,
no impersonation, no non-disclosure of machine-generated content in public environments, no military
use, no high-risk automated decisions in critical domains, and so on. It is short; read it.

## 3. Kaggle — Terms of Use (22 June 2025) and AUP

> §3 You will only use the Services for your own internal, personal, non-commercial use, and not on
> behalf of or for the benefit of any third party, and only in a manner that complies with all laws
> that apply to you.

The AUP additionally bans abusing resources for "server farming" and activity unrelated to data
science, and the Terms allow one account per person.

Plainly: **rendering paid client work on Kaggle's free GPU is use "on behalf of or for the benefit of a
third party".** Kaggle's stated consequence for abuse is termination of the account. The setup panel
says exactly this, names the consequence, and records that it was read. It cannot check how you earn —
that part is yours.

Phone verification is required before Kaggle grants GPU entitlement. A token works for metadata calls
but the kernel push or quota call will return 403 until the account is verified; the setup panel
reports that as its own state with its own instructions rather than a generic failure.

Free GPU allowance is 30 hours per week, resetting weekly.

---

## What this repository deliberately does not do

- bundle, mirror, cache or redistribute model weights;
- ship a deployment that is already authenticated, or any credential at all;
- hide the territory question, or let it be answered by silence: the exclusion is stated inside the
  terms, and one quiet link on that panel declares an excluded territory instead of continuing;
- ship client renders, client names, or this project's operator paths;
- let the setup gate be bypassed in the browser; `H3UI_SKIP_ONBOARDING=1` exists but is honoured
  **only** on a loopback bind, and it is a developer convenience, not a licence exemption. Skipping it
  does not skip your obligations under §V.2, §IV.1 or Kaggle's terms.

## If you are unsure

The safe order is: check your territory first, then Kaggle's terms, then render. Rendering in breach is
cheaper to avoid than to undo — the outputs are distribution too.
