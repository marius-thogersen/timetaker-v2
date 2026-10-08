# TimeTaker

TimeTaker is a race-timing app for RFID chips. It runs on your Windows PC and
works offline after setup.

## Install from the ZIP

1. [Download the latest ZIP of TimeTaker](https://github.com/marius-thogersen/timetaker-v2/archive/refs/heads/master.zip).
3. In File Explorer, right-click the downloaded ZIP and select **Extract All**.
   Extract it to a folder you can write to, such as `Documents\TimeTaker`.
   **Do not install it under `Program Files`**: TimeTaker saves race data in
   its installation folder.
4. Open the extracted `timetaker-v2-master` folder. Right-click an empty area
   in the folder and select **Open in Terminal**.
5. In the terminal, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   The setup installs Node.js and Python if needed, then installs the RFID
   reader's dependencies. It requires an internet connection the first time.
   If Windows asks for permission to install software, approve the prompt.

## Start TimeTaker

- Double-click **Start.cmd** to open the app in your browser. If it doesn't
  open automatically, visit [http://127.0.0.1:4577](http://127.0.0.1:4577).
- On the PC connected to the RFID scanner, double-click
  **Start-RFID-Reader.cmd**. You can use the same PC for both.
- If Windows asks to run the RFID reader as administrator, choose **Yes**.

Keep the extracted folder in place: it contains your saved race data. To start
over, use **Reset race** in the app.

## Troubleshooting

| Problem | What to do |
|---|---|
| `winget` is not available | Install or update **App Installer** from the Microsoft Store, then run the setup command again. |
| The app doesn't open in the browser | Open [http://127.0.0.1:4577](http://127.0.0.1:4577) manually. |
| Scanning a chip does nothing | Make sure the RFID reader is running, connected, and the RFID code field is focused when signing up participants. |
| The reader says TimeTaker isn't open | Start the app first, then restart the RFID reader. |

For development and technical details, see [DEVELOPER.md](DEVELOPER.md).
