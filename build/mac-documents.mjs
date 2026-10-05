// The files Lumio tells macOS it opens (Info.plist CFBundleDocumentTypes):
// Finder's "Open With", a double-click when Lumio is the default, a file
// dropped on the Dock icon. main/open-files.js takes the same kinds.
// Lumio is a default choice only for web pages; for PDFs, pictures and text
// it's an alternative ("Alternate"), so it never takes them from Preview.
// Text is matched by extension: the plain-text type also covers source code,
// which a tab would download instead of showing.
const alternate = { CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate' };

export const MAC_DOCUMENT_TYPES = [
  { CFBundleTypeName: 'HTML document', CFBundleTypeRole: 'Viewer', LSItemContentTypes: ['public.html', 'public.xhtml'] },
  { CFBundleTypeName: 'PDF document', ...alternate, LSItemContentTypes: ['com.adobe.pdf'] },
  { CFBundleTypeName: 'SVG image', ...alternate, LSItemContentTypes: ['public.svg-image'] },
  {
    CFBundleTypeName: 'Image',
    ...alternate,
    LSItemContentTypes: ['public.png', 'public.jpeg', 'com.compuserve.gif', 'org.webmproject.webp', 'public.avif', 'com.microsoft.bmp', 'com.microsoft.ico'],
  },
  { CFBundleTypeName: 'Plain text', ...alternate, CFBundleTypeExtensions: ['txt'] },
];
