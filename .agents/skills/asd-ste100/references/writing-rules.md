# ASD-STE100 writing rules — summary

Background for the `asd-ste100` skill: the rule categories of ASD-STE100 Issue 9
(January 2025), and why this repo deliberately does not carry the standard's
dictionary. This file is a study aid and a pointer, not a reproduction of the
standard. Read `SKILL.md` in this directory for the actual rewriting procedure.

## What the standard is

ASD-STE100 (Simplified Technical English) is a controlled-language standard
maintained by ASD — the AeroSpace and Defense Industries Association of Europe.
It exists so that a non-native-English technician reads maintenance
documentation the same way every time: it removes the two main sources of
misreading — words with more than one meaning, and sentences with more than one
possible structure.

The standard's mechanics:

- a "dictionary" of about 900 **approved words**, each with exactly one meaning
  and one part of speech, plus the required forms of irregular verbs;
- a list of about 1,200 **words not approved**, each with one or more approved
  replacement words;
- a set of **writing rules** (53 in Issue 9) that govern how those words may be
  combined.

## The 9 rule sections (topic map)

The rule number cited in `SKILL.md` (e.g. Rule 8.1 for punctuation) belongs to
the section layout below. The exact wording and rule numbering in this table
are only ever as current as the issue they were read from — check the standard
itself before citing a specific rule number in a document.

| Section | Topic                       | What it governs                                                                                                                                                        |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Writing conventions         | Word forms and spelling — approved words are written exactly as given                                                                                                  |
| 2       | Words                       | Word choice: one word, one meaning; approved parts of speech; technical names; the allowance for a project-specific glossary beyond the base dictionary                |
| 3       | Word order                  | Sentence patterns — subject/verb/object placed predictably; placement of adjectives and adverbs                                                                        |
| 4       | Verbs                       | Simple tenses only; active voice; imperative mood for instructions; no compound verb forms such as present perfect                                                     |
| 5       | Sentence construction       | One idea per sentence; sentence types (instruction vs description); paragraph limits — one topic, few sentences                                                        |
| 6       | Instructions and procedures | Imperative steps, one action per step, sequences as visible lists                                                                                                      |
| 7       | Descriptive text            | Describing parts, functions, and operations; present tense; no step-like command language in descriptions                                                              |
| 8       | Punctuation and word count  | Which punctuation marks are allowed (no semicolons — the mark is banned outright); word-count caps (about 20 words for procedural sentences, about 25 for descriptive) |
| 9       | Writing practices           | Consistency — repeat the same approved word instead of rotating synonyms; avoid phrasal verbs; prefer the dictionary wording over approximations                       |

## The dictionary's two halves

- **Approved words** — one meaning, one part of speech. "Close the valve" is
  the canonical trap: the standard forces wording that cannot parse as
  "the valve that is near".
- **Unapproved words** — about 1,200 entries with suggested replacements,
  covering the words most often misread: phrasal verbs, excess formality, and
  figurative or rare English.

The dictionary is the enforceable half of the standard; the rules are the
describable half. This skill can therefore fully deliver only the rules.

## The structural / lexical split

- **Structural rules** describe sentence shape — active voice, sentence length,
  punctuation, noun-cluster depth, one-idea-per-sentence, lists. They are
  self-contained: checkable from the rule description alone, no dictionary
  needed.
- **Lexical rules** are defined by the dictionary — which exact word is
  approved, and in which part of speech. Without the dictionary they degrade
  into a direction of travel: prefer the plainest, most common word and use it
  the same way every time.

`SKILL.md` "Core Rewrite Rules" encodes this split: apply the structural table
with confidence, treat the lexical table as preference, and say so in the
output rather than implying dictionary compliance.

## Why the dictionary is not in this repo

ASD-STE100 is free to obtain but not free to redistribute. Issue 9, page 2
states that no reproduction or publication of it, in whole or in part, shall be
made without the written authority of an officer of ASD, and grants free
reproduction rights only to eight listed categories: ASD/AIA/AIAC member
associations and their member companies and customers, member-state defence
ministries, A4A, airworthiness authorities, and universities and research
institutes for educational purposes. This project is in none of those
categories, so neither this file nor the skill reproduces the dictionary or the
rule text verbatim.

When exact ASD-approved wording matters (actual aircraft maintenance
documentation, or any document that must claim compliance), obtain the standard
and check word by word against the real dictionary.

## Citations

- Official download / request page:
  <https://www.asd-ste100.org/STE_downloads.html> — a request form that emails
  you the standard, not a direct download.
- The standard itself: ASD-STE100, Issue 9, January 2025 — the sole authority
  on exact rule wording, the approved dictionary, and the reproduction terms
  quoted above.
- This skill's procedure: `SKILL.md` in this directory, which turns the rule
  categories above into a rewriting workflow for agent-consumed text.
- Worked examples: `examples/before-after.md` in this directory.
