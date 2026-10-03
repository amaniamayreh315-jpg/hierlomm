# Client tools to add in the ElevenLabs agent

Agent → Tools → Add tool → **Client**. Turn on *Wait for response* for each. Names and parameters must match exactly.

### log_answer
Description: Save the expert's answer in their own words.
| Parameter | Type | Required | Description |
|---|---|---|---|
| kind | string | yes | One of: reason, limit, exception, stop_and_ask |
| quote | string | yes | The expert's own words, as exactly as possible |
| about | string | no | The invoice number or step the answer is about |

### off_record
Description: Pause or resume capture when the expert asks to go off or back on the record.
| Parameter | Type | Required | Description |
|---|---|---|---|
| on | boolean | yes | true = off the record, false = back on the record |

### debrief_done
Description: Call when the expert has confirmed the teach-back.
| Parameter | Type | Required | Description |
|---|---|---|---|
| confirmed | boolean | yes | true if the expert said that is how it works |
| corrections | string | no | Every correction the expert made, in their words |

### replay_moment
Description: Show the new hire the expert's screen moment for a guardrail.
| Parameter | Type | Required | Description |
|---|---|---|---|
| rule_id | string | yes | Guardrail id, e.g. g1 |

## Dynamic variables used
`phase`, `context`, `expert_name`, `learner_name`, `first_message`. The app sends them when each session starts.
