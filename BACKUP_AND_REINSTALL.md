# Backup and Reinstall Guide for Legacy Shortcuts Users

If you are updating from an older version of **Shortcuts** and the Plugin Installer fails with a git pull conflict, your shortcuts can still be preserved.

Older versions stored editable shortcut files inside the plugin install folder. That was a bad storage model for real user data and could block updates.

This guide helps you back up your shortcuts, reinstall the plugin cleanly, and restore your files afterward.

## 1. Back up your shortcuts

Your old shortcuts are typically here:

- `/a0/usr/plugins/slash_shortcuts/shortcuts/`

Create a backup:

```bash
mkdir -p /a0/usr/workdir/shortcuts_backup
cp -a /a0/usr/plugins/slash_shortcuts/shortcuts/. /a0/usr/workdir/shortcuts_backup/
```

Verify the backup:

```bash
find /a0/usr/workdir/shortcuts_backup -maxdepth 1 -type f | sort
```

## 2. Remove the old plugin install

Use the Plugin Installer uninstall flow if available.

If doing it manually:

```bash
rm -rf /a0/usr/plugins/slash_shortcuts
```

## 3. Install the latest version cleanly

Reinstall **Shortcuts** from the Plugin Installer.

Newer versions separate:

- editable user shortcuts in `/shortcuts/`
- shipped examples in `/examples/`

## 4. Restore your shortcuts

After reinstalling, restore your backed-up files:

```bash
mkdir -p /a0/usr/plugins/slash_shortcuts/shortcuts
cp -a /a0/usr/workdir/shortcuts_backup/. /a0/usr/plugins/slash_shortcuts/shortcuts/
```

Verify the restore:

```bash
find /a0/usr/plugins/slash_shortcuts/shortcuts -maxdepth 1 -type f | sort
```

## 5. What changed in newer versions

The plugin now treats global shortcuts as user-owned editable data and ships examples separately in `/examples/`.

That should prevent this exact update conflict from continuing once you are on the new layout.
