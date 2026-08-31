# Before / after examples

Worked examples for the `asd-ste100` skill. The first two show the classic
public examples of why the standard exists; the rest are agent-consumed strings
in HiveHive's own domains — backend and image-service error strings, status
reports, tool descriptions, inter-agent instructions.

**These examples are illustrative.** They are not extracted from ASD's approved
dictionary, and no rewrite here claims the standard's compliance if the wording
happens to match. Use the rule table format shown in `SKILL.md` → Output Format
when the caller asks for the reasoning.

## The classics

| Rule violated                         | Original                                      | Simplified                                                 |
| ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Ambiguous word (adjective vs command) | "Close the valve before you remove the pump." | "Set the valve to the OFF position. Then remove the pump." |
| Present perfect tense                 | "We have received your request."              | "We received your request."                                |

Why the first one matters: a technician (or a language model) parsing
"close the valve" must decide whether "close" is the adjective — "the
valve that is near" — or the command. The rewrite removes the decision.

## Agent-consumed strings (HiveHive-flavored)

Each row is a real shape of text this repo produces or consumes: an error
string the homepage renders, a status line ops reads, a tool description a
service exposes, an instruction one agent passes to another.

| Rule violated                       | Original                                                                                                                                              | Simplified                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Synonym rotation                    | "Check the log. Verify the connection. Confirm the upload."                                                                                           | "Check the log. Check the connection. Check the upload."                                                           |
| Nominalization + padding            | "This endpoint provides the ability to retrieve the current status of a module, and will return an error in the event that the module is not found."  | "Get the current status of a module. Return an error if the module does not exist."                                |
| Soft phrasal verbs                  | "Spin up the stack and reach out to the image service."                                                                                               | "Start the stack. Contact the image service."                                                                      |
| Run-on + em dash                    | "The upload stalled — check the firewall — a Private profile can still block a Public WLAN."                                                          | "The upload stalled. Check the firewall rule. A Private profile can still block a Public WLAN."                    |
| Condition buried in a long sentence | "When the module has failed to register before the timeout has elapsed, the LED will begin to blink red, so check the server log for a 403 response." | "If the module does not register before the timeout, the LED blinks red. Check the server log for a 403 response." |
| Noun cluster                        | "the module heartbeats measurement retention policy handler"                                                                                          | "the handler that enforces measurement retention per module"                                                       |
| One instruction per sentence        | "Start the stack and read the failing test, then contact me."                                                                                         | "Start the stack. Read the failing test. Then contact me."                                                         |

## Keep the hedge

The modality rule is the one a length cap tempts you to break. Status text
frequently _needs_ the hedge, and a shorter sentence that promotes it to a
fact is a different claim:

| Rule respected     | Original                                                         | Simplified                                                                                                              |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Modality preserved | "The upload may have failed because the server was unreachable." | "The upload may have failed because the server was unreachable." — kept as-is; "may have failed" is the reportable fact |

A rewording attempt that is a fact-invention, not a rewrite:

- Original: "The job has completed and the image is available now."
- Wrong: "The job completed. The image is available." — present perfect
  carries current relevance; the state may still hold at read time.
- Right (per `SKILL.md` "Simple tenses"): keep the compound form and flag it:
  "The job has completed. The image is available now." with a
  `Kept as-is:` line naming the current-relevance payload.

## Notes on dictionary-sensitive cases

"Set the valve to the OFF position" is _more_ explicit than the original but
uses words the dictionary might not approve for this meaning — which is why the
skill's rule table grades the lexical rules as "direction of travel only".
The structural gain (no adjective/verb ambiguity) is checkable; the word
choice is not, without the standard in hand.
