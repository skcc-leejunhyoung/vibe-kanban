# Additional CA certificates

Drop a root CA `*.crt` here when the remote image needs to trust an extra
certificate authority for HTTPS (build-time and runtime). The Dockerfile copies
this folder and, **only if** a `*.crt` is present, trusts it
(`update-ca-certificates`) in both the build and runtime stages so rustup/cargo,
git, and the server's outbound web push HTTPS work.

Certs are git-ignored (see `.gitignore`) — they are machine-specific and must not
be committed. This README keeps the folder present so the Dockerfile `COPY` works
on clean checkouts (where the CA step becomes a no-op).

To export a CA already trusted by this machine (macOS):

```sh
security find-certificate -a -c "<ca-name>" -p /Library/Keychains/System.keychain \
  > crates/remote/local-ca/extra-ca.crt
```
