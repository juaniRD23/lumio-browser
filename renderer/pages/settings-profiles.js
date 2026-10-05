// Settings › You and Lumio › Profiles: opens the profile picker, where
// profiles are added, opened and deleted (main/picker.js).
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);

const info = await page.invoke('page:profiles');
if (info?.guest) $('#profiles-desc').textContent = 'You’re browsing as a Guest. Nothing you do here is kept after you close Guest.';
else if (info?.count > 1) $('#profiles-desc').textContent = `${info.count} profiles on this computer, each with its own history, bookmarks, passwords, Lumio account and settings.`;
$('#profiles-manage').addEventListener('click', () => page.invoke('page:profiles-manage'));
