# smart-forms-health-links

Deploys Smart Forms Health Links: a confidential SMART app that launches from a clinical system,
mints a SMART Health Link carrying a form for a patient to fill in, and receives the completed
response back through the link's own token channel.

One container serves the SPA, the BFF API and the public SHL routes from a single origin, because
the session cookie must be same-site with the API and because a SHL embeds exactly one origin.

## Features

- One pod, one origin: the SPA, `/api`, `/shl` and `/.well-known/jwks.json` behind one Ingress
  rule.
- The issuer registry as a ConfigMap, holding `env:VARIABLE_NAME` references rather than
  credentials.
- Credentials read from a Secret you create yourself. The chart never templates a secret value,
  so a rendered manifest is safe to commit or to diff.
- SQLite on a PersistentVolumeClaim, with the Deployment pinned to a single replica and the
  `Recreate` strategy so that two pods never hold the same file.
- Liveness, readiness and startup probes on `GET /health`.

## Prerequisites

- Kubernetes 1.25 or later.
- An Ingress controller, and a DNS name resolving to it.
- A StorageClass that can provision a `ReadWriteOnce` volume.
- The image built and pushed somewhere the cluster can pull from:

  ```bash
  docker build -t ghcr.io/aehrc/smart-forms-health-links:0.1.0 .
  docker push ghcr.io/aehrc/smart-forms-health-links:0.1.0
  ```

- A Secret holding the credentials, created before the release. See below.

## The Secret you must create first

The chart names an existing Secret and mounts every key in it as an environment variable. It
never writes one, so the values stay out of the chart, out of the values file and out of any
rendered manifest.

Three keys are always needed:

| Key                     | Contents                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `SESSION_COOKIE_SECRET` | Signs the `shl_session` cookie. At least 32 characters; generate with `openssl rand -base64 48`.      |
| `LAUNCH_CLIENT_SECRET`  | The confidential launch client's secret, as registered with the FHIR server's authorisation server.   |
| `BACKEND_PRIVATE_JWK`   | The SMART Backend Services RS384 signing key, one line of JWK JSON with the private members included. |

Add one key per additional `env:VARIABLE_NAME` reference in the registry: a second issuer with
its own launch client needs its own key.

```bash
kubectl create secret generic smart-forms-health-links \
  --from-literal=SESSION_COOKIE_SECRET="$(openssl rand -base64 48)" \
  --from-literal=LAUNCH_CLIENT_SECRET="$LAUNCH_CLIENT_SECRET" \
  --from-literal=BACKEND_PRIVATE_JWK="$BACKEND_PRIVATE_JWK"
```

Rendering fails with a clear message if `smartFormsHealthLinks.existingSecret` is unset, and
again if `smartFormsHealthLinks.appOrigin` cannot be derived from an Ingress host.

## Installation

Write a values file naming the image, the host, the Secret and the issuers:

```yaml
# values.production.yaml
smartFormsHealthLinks:
  image: "ghcr.io/aehrc/smart-forms-health-links:0.1.0"
  existingSecret: "smart-forms-health-links"

  ingress:
    className: "nginx"
    host: "shl.example.org"
    annotations:
      cert-manager.io/cluster-issuer: "letsencrypt"
    tls:
      enabled: true
      secretName: "shl-example-org-tls"

  issuers:
    - issuer: "https://ehr.example.org/fhir"
      label: "Example EHR"
      launchClient:
        clientId: "smart-forms-health-links"
        clientSecret: "env:LAUNCH_CLIENT_SECRET"
        scopes: "openid fhirUser launch launch/patient online_access user/*.cruds"
      backendClient:
        clientId: "smart-forms-health-links-backend"
        privateKeyJwk: "env:BACKEND_PRIVATE_JWK"
        scopes: "system/QuestionnaireResponse.c system/Task.r system/Task.u"
      grantTtlSeconds: 3600
```

Then install:

```bash
helm upgrade --install shl helm/smart-forms-health-links \
  --namespace smart-forms-health-links --create-namespace \
  --values values.production.yaml
```

Finally, register the app with each authorisation server in the registry. The redirect URI is
`https://shl.example.org/auth/callback` and the Backend Services `jwks_uri` is
`https://shl.example.org/.well-known/jwks.json`; both are printed on install.

## Configuration

| Parameter                                            | Description                                                                                                    | Default                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `smartFormsHealthLinks.image`                        | Container image to run                                                                                         | `smart-forms-health-links:latest` |
| `smartFormsHealthLinks.imagePullPolicy`              | Image pull policy                                                                                              | `Always`                          |
| `smartFormsHealthLinks.appOrigin`                    | `APP_ORIGIN`, the one origin the app is published on. Derived from the Ingress host when unset                 | `~`                               |
| `smartFormsHealthLinks.existingSecret`               | Name of the Secret holding the credentials. Required                                                           | `""`                              |
| `smartFormsHealthLinks.issuers`                      | Issuer registry, rendered into the ConfigMap as `issuers.json`. Secret-bearing fields hold `env:VARIABLE_NAME` | `[]`                              |
| `smartFormsHealthLinks.config`                       | Extra environment variables for the server process                                                             | `{}`                              |
| `smartFormsHealthLinks.resources`                    | Container resource requests and limits                                                                         | `{}`                              |
| `smartFormsHealthLinks.service.type`                 | Service type                                                                                                   | `ClusterIP`                       |
| `smartFormsHealthLinks.service.port`                 | Port the Service publishes                                                                                     | `80`                              |
| `smartFormsHealthLinks.ingress.enabled`              | Create an Ingress                                                                                              | `true`                            |
| `smartFormsHealthLinks.ingress.className`            | `ingressClassName` of the controller to use                                                                    | `~`                               |
| `smartFormsHealthLinks.ingress.host`                 | Host the app is published on. Required unless `appOrigin` is set and the Ingress is disabled                   | `""`                              |
| `smartFormsHealthLinks.ingress.annotations`          | Annotations on the Ingress, for example a cert-manager issuer                                                  | `{}`                              |
| `smartFormsHealthLinks.ingress.tls.enabled`          | Terminate TLS at the Ingress. Also decides the derived `APP_ORIGIN` scheme                                     | `true`                            |
| `smartFormsHealthLinks.ingress.tls.secretName`       | Secret holding the certificate, when the controller does not source it from an annotation                      | `~`                               |
| `smartFormsHealthLinks.persistence.size`             | Size of the volume holding the SQLite file                                                                     | `1Gi`                             |
| `smartFormsHealthLinks.persistence.storageClassName` | StorageClass for that volume; the cluster default when unset                                                   | `~`                               |
| `smartFormsHealthLinks.nodeSelector`                 | Pod node selector                                                                                              | `{}`                              |
| `smartFormsHealthLinks.tolerations`                  | Pod tolerations                                                                                                | `[]`                              |
| `smartFormsHealthLinks.affinity`                     | Pod affinity rules                                                                                             | `{}`                              |

The Deployment fixes the rest: `PORT=3000`, `SQLITE_PATH=/data/links.sqlite` on the volume, and
`ISSUER_REGISTRY_PATH=/etc/smart-forms-health-links/issuers.json` on the ConfigMap mount. There
is no replica count, because the state is one SQLite file.

## Examples

### Development, on a cluster with no TLS

```yaml
smartFormsHealthLinks:
  image: "smart-forms-health-links:latest"
  imagePullPolicy: "IfNotPresent"
  existingSecret: "smart-forms-health-links"
  ingress:
    host: "shl.localtest.me"
    tls:
      enabled: false
```

`APP_ORIGIN` becomes `http://shl.localtest.me`, which is what the authorisation server must have
registered as the redirect URI's origin.

### Behind a proxy that publishes a different host

```yaml
smartFormsHealthLinks:
  appOrigin: "https://forms.health.example.org"
  existingSecret: "smart-forms-health-links"
  ingress:
    host: "shl-internal.example.org"
```

The derived origin would be wrong here, so it is set explicitly. Links minted by this deployment
carry `https://forms.health.example.org`, whatever the Ingress host is.

### With resource limits

```yaml
smartFormsHealthLinks:
  existingSecret: "smart-forms-health-links"
  ingress:
    host: "shl.example.org"
  resources:
    requests:
      memory: "256Mi"
      cpu: "100m"
    limits:
      memory: "512Mi"
      cpu: "500m"
```

## Upgrading

The `Recreate` strategy means a short outage on every upgrade: the old pod terminates and
releases the volume before the new one starts. That is deliberate - two pods writing one SQLite
file is worse than a few seconds of downtime.

Editing `smartFormsHealthLinks.issuers` changes an annotation checksum on the pod template, so
the pod restarts and picks the registry up. The server reads it once, at startup, so nothing else
would.

Sessions and minted invitations live on the volume and survive the restart.

## Uninstalling

```bash
helm uninstall shl --namespace smart-forms-health-links
```

Helm does not delete the PersistentVolumeClaim, so the minted links survive a reinstall. Remove
it deliberately when you want the state gone:

```bash
kubectl --namespace smart-forms-health-links delete persistentvolumeclaim shl-pvc
```

## Compatibility

| Chart version | App version | Kubernetes |
| ------------- | ----------- | ---------- |
| 0.1.0         | 0.1.0       | >= 1.25    |
