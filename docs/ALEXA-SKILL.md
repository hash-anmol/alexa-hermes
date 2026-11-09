# Create the private Alexa skill

About ten minutes, once. The skill lives only in your own developer account (it never goes to the Alexa store) and works on Echos signed in to the **same Amazon account**.

Before you start: the skill server is running and reachable at `https://<your address>/health` ([TUNNELS.md](TUNNELS.md)).

## 1. Make the interaction model

```bash
node bin/alexa-hermes.js model            # uses skill.invocation from config.json
# -> wrote build/interaction-model.hermes.json  (323 of the 350 intents + slots Alexa allows)
```

## 2. Create the skill

1. Open the [Alexa developer console](https://developer.amazon.com/alexa/console/ask) and sign in with the Amazon account your Echo uses. **Create Skill**.
2. Name: anything (for example *Hermes*). Primary locale: **your language and region** (for example English (US), English (IN)). Add the same model to every locale you want.
3. Choose a **Custom** skill with **your own endpoint** ("Provision your own"; the console's wording changes from time to time) and start from scratch, with no template.

## 3. Paste the model

1. **Build > Invocations > Skill Invocation Name**: the word you say after "ask" (the default is `hermes`). It must match `skill.invocation`.
2. **Build > Interaction Model > JSON Editor**: replace everything with the contents of `build/interaction-model.<name>.json`. **Save**.
3. **Build > Interfaces**: switch **Audio Player** on. Without it the answer cannot play. **Save**.
4. **Build > Endpoint**: choose **HTTPS**. Default Region: `https://<your address>/alexa`. Certificate type: **My development endpoint has a certificate from a trusted certificate authority**. **Save**.
5. **Build skill** (top right). It must finish with *Build was successful*.

If the build fails with *"total number of slots and intents … exceeds the limit of 350"*, you edited the model or added phrases; shrink it or regenerate it.

## 4. Tell the server which skill it serves

Copy the **Skill ID** (`amzn1.ask.skill.…`; in the console skill list, *View Skill ID*) into `config.json`:

```json
"skill": { "applicationId": "amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "publicBase": "https://<your address>" }
```

Restart the server (`systemctl --user restart alexa-hermes`) and run `node bin/alexa-hermes.js doctor`.

## 5. Try it

- **Test tab** in the console: set *Skill testing is enabled in* to **Development**, then type `open hermes`, then `check my latest emails`.
  The simulator shows the JSON and plays nothing; look for an `AudioPlayer.Play` directive in the response.
- **On the Echo:** *"Alexa, open Hermes"*, wait for *"Hermes here. What do you need?"*, then speak. Or in one go: *"Alexa, ask Hermes what's on my plate today"*.

## 6. Routines (optional)

In the Alexa app: **More > Routines > +**. Set a trigger (a time, or a phrase), then **Add action > Skills > Your skills** or **Custom** and type, for example, `ask Hermes to ring the alarm` or `ask Hermes what's on my calendar today`. Routines are a good way to start the alarm sound or a daily briefing.

## More skills (profiles)

One skill per Hermes profile: see [MODES.md](MODES.md#profiles). Each is a copy of steps 2-5 with its own invocation name and the same endpoint.

## Notes

- Alexa only calls your endpoint over HTTPS on port 443 with a trusted certificate (a tunnel provides this).
- Changing the model later (new phrases, `extraPhrases`): regenerate, paste, **Save**, **Build skill** again.
- Alexa has no way to hand over *completely* free text in a custom skill: every spoken sentence must begin with a word the model knows. That is why the model lists hundreds of opening words; see [VOICE-COMMANDS.md](VOICE-COMMANDS.md).
