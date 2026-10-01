# TimeTaker

Race timing with RFID chips. Runs on your own PC, no internet connection
needed once installed.

## Install (one command)

Open **PowerShell** on the PC you'll use for the race, paste this, and press Enter:

```powershell
irm https://raw.githubusercontent.com/marius-thogersen/timetaker-v2/main/bootstrap.ps1 | iex
```

This downloads TimeTaker to your Desktop, installs anything it needs
(Node.js and Python), and adds two shortcuts to your Desktop:

- **TimeTaker** — the app itself.
- **TimeTaker RFID Reader** — reads the chip scanner. Only needed on the PC
  the scanner is plugged into (can be the same PC).

If Windows shows a security prompt while installing, click **More info** →
**Run anyway** — this is expected for a script downloaded from the internet.

The RFID reader reads scans system-wide, so Windows may ask you to
**"Run as administrator"** the first time you open it — click yes.

## Using it on race day

1. Double-click the **TimeTaker** shortcut. A browser window opens.
2. **Sign up participants**: click into the RFID code field and scan each
   person's chip — the code fills in automatically. Type their name, pick a
   gender, and click **Add participant**. Repeat for everyone.
3. Made a mistake? Click **Remove** next to a participant to delete them
   (only possible before the race starts).
4. When everyone is signed up, double-click **TimeTaker RFID Reader** on the
   scanning PC, and check it says it's connected.
5. Click **Start race**. The screen switches to a live leaderboard, ranked by
   number of laps. It updates automatically as chips are scanned.
6. Need to redo everything? Click **Reset race** on the leaderboard screen.
   This clears all participants and scans and goes back to signup.

## If something goes wrong

| Problem | What to do |
|---|---|
| The install command fails / winget not found | Update Windows (Microsoft Store → "App installer"), then try again. |
| Browser doesn't open automatically | Go to `http://127.0.0.1:4577` manually. |
| Scanning a chip does nothing | Make sure the RFID field is focused (click it first), and that the "TimeTaker RFID Reader" window is open and shows it's connected. |
| RFID Reader window says it isn't connected | Make sure the TimeTaker app is open first, then reopen the RFID Reader. |
| I want to start completely fresh | Click **Reset race**, or delete the `data` folder inside the TimeTaker folder on your Desktop. |

---

For how the app is built and how to change it, see **DEVELOPER.md**.
