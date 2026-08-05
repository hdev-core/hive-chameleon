# Round scoring rules

`scoring-1` is the first executable, server-owned round score. The Nakama match computes it from
authoritative timestamps, roles, discoveries, outcomes, and accepted Answer Check likes. Clients
render the supplied totals and never calculate or submit score.

| Input | `scoring-1` value |
| --- | ---: |
| Hider survival during the hunting phase | 10 points per completed second |
| Hider survives to timeout | 500 points |
| Sole remaining Infection Hider at timeout | 250 additional points |
| Authoritative discovery made as a Hunter | 300 points |
| Discovery speed | 2 points per whole hunting second remaining, capped at 300 per discovery |
| Final-role Hunter when Hunters win | 400 points |
| Accepted disguise like received | 100 points per like |

The public scoreboard includes only players assigned Hider at round start; the original Hunter is
not ranked. An Infection conversion does not erase the converted player's Hider-round entry. Rows
sort by total descending and then player UUID ascending for deterministic ties. During an active
round, Nakama computes and caches a provisional scoreboard in 30-second
batches. Clients briefly reveal each new batch in the left-side scoreboard; reconnecting clients
receive the existing cache without forcing an early refresh. This cadence prevents immediate
score changes from becoming a discovery side channel. Answer Check and terminal completion create
an immediate final batch, and each accepted disguise like creates an immediate updated final
batch. Terminal participant rows and canonical complete-result JSON store the fixed four-decimal
total and the complete integer breakdown under the `scoring-1` version.

Changing a weight, cap, input, tie-breaker, or reveal cadence requires a new scoring-rule version;
completed results are never silently reinterpreted.
