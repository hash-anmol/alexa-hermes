# What you can say

Start with **"Alexa, ask Hermes …"** (replace *Hermes* with your invocation name), or say **"Alexa, open Hermes"**, wait for *"Hermes here. What do you need?"*, then speak.

## Anything: free-form prompts

Whatever follows goes to Hermes as the prompt:

- *"check my latest emails"*, *"what's on my plate today"*, *"remind me to call Sam at five"*
- *"send Priya the summary"*, *"find the invoice from October"*, *"how much did I spend on cloud this month"*

### Why a sentence can be refused ("I missed that")

A custom Alexa skill cannot receive a completely open sentence. Alexa only passes free text to a skill when the sentence **starts with a word the skill's model lists**. So `alexa-hermes model` lists about 150 opening words that change the meaning (questions: *what, how, when, why, who, which, should…*; verbs: *check, send, find, show, remind me, summarize…*; time words: *today, tomorrow, latest, new…*) and one shared catch-all for little words that can be dropped without changing anything (*my, our, the, a, and, okay, please, I need…*).

- Verbs and question words are **put back**: *"send a mail to Sam"* reaches Hermes as exactly that.
- Little words are **dropped**: *"our latest emails"* reaches Hermes as *"latest emails"*.
- A sentence starting with a word that is in neither list gets *"I missed that. Say it again, starting with a word like check, show, find, send, what or how."*

Alexa limits a model to **350 intents + slots**; each opening word costs two, which is why the list cannot grow without limit. To see the current count: `node bin/alexa-hermes.js model`.

## Conversations: answer Hermes, or pick one up later

Every *"ask Hermes …"* starts a new Hermes conversation (a named Hermes session, `hermes chat --continue <name>`). Two ways to keep one going:

1. **Hermes asks you something.** When its answer ends on a question, the Echo keeps listening. Your reply goes into the same conversation. Start your answer with a word like *my, the, I, it, yes, no* (the same opening-word rule as above), for example *"the work one"* or *"yes"*.
2. **Come back to it.** Say **"ask Hermes, continue …"** or **"ask Hermes, follow up …"** followed by what you want to add, for example *"continue and move the ten o'clock to noon"*. *"Tell me more"* does the same. On its own, *"ask Hermes, continue"* reopens the last conversation and listens. The last conversation is kept for 12 hours (`skill.resumeHours`), one per Hermes profile.

*"start over"*, *"fresh start"*, *"different topic"* forget the last conversation. After a stream answer that ends on a question, the stream tells you to say *"ask Hermes, continue, and then your answer"*, because a stream cannot listen.

`skill.listen` sets when the Echo keeps listening after an answer: `"question"` (default), `"always"` or `"never"`.

## Bluetooth music and "music mode"

A live spoken stream takes the speaker over, and that **disconnects Bluetooth music**. So an answer that arrives within `skill.speech.quickReplyMs` (default 7 seconds) is said in **Alexa's own voice**: your music just ducks and carries on. Only a slower answer becomes the Kokoro stream (and interrupts the music).

**Music mode** never uses the stream: say *"ask Hermes, music mode on"* (or *protect my music*, *bluetooth mode on*). A slow answer is then kept: Hermes says *"On it"* and the Echo listens for a few seconds, so just say *"give me the answer"* when you are ready (later, say *"Alexa, ask Hermes, give me the answer"*), or get a message if `hermes.notifyTarget` is set. Hermes often needs 8 to 15 seconds, more than the 7 an inline answer can wait, so **music mode is the reliable way to keep Bluetooth connected**. *"Music mode off"* turns the stream back on. Set `skill.speech.quickReplyMs` to `0` to always stream.

## Built-in commands

| Say | What happens |
|---|---|
| *"give me the answer"*, *"any update"*, *"are you done"*, *"progress report"*, *"update me"* | reads a slow answer, or says how far a long task has got |
| *"cancel the task"*, *"abort the task"* | stops the Hermes run that is going |
| *"server health"*, *"health report"*, *"system status"*, *"disk and memory"* | storage, memory, swap, load, uptime, services, containers and the busiest tasks, from real commands (Linux) |
| *"test the server"*, *"test everything"* | tests the bridge and Hermes |
| *"test the bridge"*, *"test my bridge"* | this machine: is the skill service up, is the public address answering |
| *"test the Hermes server"*, *"test Hermes"*, *"ping Hermes"* | the Hermes machine: reachable, version, how fast it answered |
| *"update Hermes"*, *"upgrade Hermes"* | `hermes update`, spoken as it goes (local and ssh) |
| *"turn on yolo mode"*, *"stop asking for permission"* | Hermes runs commands without asking (local and ssh) |
| *"turn off yolo mode"*, *"ask for permission again"*, *"yolo mode status"* | the opposite, and what it is now |
| *"continue …"*, *"follow up …"*, *"tell me more"*, *"start over"* | pick up, or drop, the last conversation (see above) |
| *"music mode on"*, *"music mode off"* | never interrupt Bluetooth music with a stream (see above) |
| *"ring the alarm"*, *"start the alarm"*, *"play the alarm"* | plays your own mp3 on a loop until you say *"Alexa, stop"* |

Add your own phrases for these in `config.json` (`skill.extraPhrases`), for example:

```json
"extraPhrases": { "TestHermesIntent": ["test my cloud server"], "RingAlarmIntent": ["ring my morning alarm"] }
```

Phrases that start with one of the free-form opening words are refused and reported by `alexa-hermes model`.

## Long tasks

The answer plays as a live stream with a soft tick about every minute while Hermes works. After `skill.speech.foregroundSec` (default 15 minutes) the stream tells you it will keep working in the background; ask *"any update"* or *"give me the answer"*, or (local/ssh, with `hermes.notifyTarget` set) get a message when it finishes.

## The alarm

Put your own mp3 in `audio/` (it is git-ignored; this project never ships audio). `alexa-hermes` plays the first mp3 it finds, or `skill.alarmSound`. Create an Alexa Routine at your wake-up time whose action is the custom phrase `ask Hermes to ring the alarm`. It rings for up to `skill.maxRingMinutes` (default 30) or until you say *"Alexa, stop"*.

## Routine ideas

Routines are set in the Alexa app (More > Routines), not by this project:

- **Wake-up:** at your time, *ask Hermes to ring the alarm*.
- **Morning brief:** *ask Hermes what's on my plate today and any urgent emails*.
- **Evening wrap-up:** *ask Hermes to summarize what I got done today and what's left for tomorrow*.
- **Daily health:** *ask Hermes for server health*.
- **Weekly:** *ask Hermes to update Hermes*.
