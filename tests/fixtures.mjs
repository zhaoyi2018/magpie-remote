// Public test-only fixtures. They are never used by installed plugins.
// Avoid ssh2 1.17's random Ed25519 conversion: leading zero bytes can be lost.
export const keys = {
  private: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACC1BFzyYNJECuElN6x+nxJ+CDrnFsDYFnq8x1Y9hYpLdwAA
AIgGSwe+BksHvgAAAAtzc2gtZWQyNTUxOQAAACC1BFzyYNJECuElN6x+nxJ+CDrn
FsDYFnq8x1Y9hYpLdwAAAEADBUmB9su1ycogQAOa7zjc7GNxMk018TAqMXNoBQSW
6LUEXPJg0kQK4SU3rH6fEn4IOucWwNgWerzHVj2Fikt3AAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`,
  public: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILUEXPJg0kQK4SU3rH6fEn4IOucWwNgWerzHVj2Fikt3",
};

export const encryptedKeys = {
  passphrase: "fixture-passphrase",
  private: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jYmMAAAAGYmNyeXB0AAAAGAAAABBW
a4oKOvyfwvKycNlfuADXAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIOmu
7r11CKWBYZuveAH1jIqgGx2i9bnW+F12wQzarqGqAAAAkHvs0PV2iDzF/29SNoZE
skkf46MbGAoQwQiG6SeNJPN1or7mqOgfYptcKsIF0Jrmr62vMGIVZYCC8qheHP66
RDhCgOXQJr1AH52seZZnke5/99TJBNNU5CedaujTQMweX6/Uje9nTALLC3HI1t7P
tE7V8DY6HU84QeCDb46igdgChIIksZinBupvH/Axbxmf8g==
-----END OPENSSH PRIVATE KEY-----
`,
  public: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOmu7r11CKWBYZuveAH1jIqgGx2i9bnW+F12wQzarqGq",
};
