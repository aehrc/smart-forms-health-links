# Smart Forms Health Links Helm chart

Deploys [Smart Forms Health Links](https://github.com/aehrc/smart-forms-health-links),
a single-page app for sending and filling FHIR Questionnaires over SMART Health
Links. The app has no server side: the chart runs nginx serving the built
static site.

## Features

- Serves the app from nginx, with unknown paths falling through to
  `index.html` so client-side routing and shared links work.
- Supplies `/config.json` from a ConfigMap, so one image can be pointed at
  different forms, terminology and FHIR servers.
- Rolls the pods when that configuration changes, via a checksum annotation.
- Runs unprivileged, with a read-only root filesystem and all capabilities
  dropped.
- Probes `/healthz`, which answers independently of the app bundle.

## Prerequisites

- Kubernetes 1.19 or later, for `networking.k8s.io/v1` ingresses if you add
  one.
- Helm 3.

The chart contains no Ingress: how the app is exposed is environment-specific,
so the ingress is applied beside the release. See `deploy/demo/ingress.yaml`
in the repository for the ALB ingress used by the demo deployment.

## Installation

```bash
helm upgrade --install smart-forms-health-links deploy/helm/smart-forms-health-links \
  --namespace formlinks \
  --set smartFormsHealthLinks.image=my-registry/smart-forms-health-links:abc1234
```

The `Service` is a `ClusterIP` on port 80. To reach it without an ingress:

```bash
kubectl port-forward service/smart-forms-health-links-service 8080:80 --namespace formlinks
```

## Configuration

| Parameter                                       | Description                                                                                                 | Default                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `smartFormsHealthLinks.image`                   | Container image to run                                                                                      | `smart-forms-health-links:latest`    |
| `smartFormsHealthLinks.imagePullPolicy`         | Image pull policy                                                                                           | `Always`                             |
| `smartFormsHealthLinks.replicas`                | Number of replicas                                                                                          | `2`                                  |
| `smartFormsHealthLinks.config`                  | Contents of `/config.json`. Empty serves the file baked into the image; any value replaces it wholesale      | `{}`                                 |
| `smartFormsHealthLinks.service.type`            | Service type                                                                                                | `ClusterIP`                          |
| `smartFormsHealthLinks.service.port`            | Service port                                                                                                | `80`                                 |
| `smartFormsHealthLinks.resources.requests.cpu`  | CPU request                                                                                                 | `100m`                               |
| `smartFormsHealthLinks.resources.requests.memory` | Memory request                                                                                             | `32Mi`                               |
| `smartFormsHealthLinks.resources.limits.cpu`    | CPU limit                                                                                                   | `500m`                               |
| `smartFormsHealthLinks.resources.limits.memory` | Memory limit                                                                                                | `128Mi`                              |
| `smartFormsHealthLinks.nodeSelector`            | Node selector for the pods                                                                                  | `{}`                                 |
| `smartFormsHealthLinks.tolerations`             | Tolerations for the pods                                                                                     | `[]`                                 |
| `smartFormsHealthLinks.affinity`                | Affinity rules for the pods                                                                                  | `{}`                                 |

### Application configuration

`smartFormsHealthLinks.config` is written verbatim as `/config.json`, which the
app fetches at boot. It is a replacement rather than an overlay: a deployment
that sets one field must set every field it cares about, because nothing merges
it with the file in the image. The fields are documented in `src/lib/config.ts`.

Two of them decide whether the app can do anything transactional at all.
`responseServerUrl` is where reviewed responses are written and
`blobServerUrl` is where SMART Health Link payloads are hosted; both are
deliberately unset by default, and the app explains rather than guesses when
they are missing. `linkBaseUrl` must name the public origin, since links minted
by a pod that used its own origin would be unreachable.

```yaml
smartFormsHealthLinks:
  config:
    formsServerUrl: "https://smartforms.csiro.au/api/fhir"
    terminologyServerUrl: "https://r4.ontoserver.csiro.au/fhir"
    linkBaseUrl: "https://formlinks.example.org"
    linkCodec: "shl"
    responseServerUrl: "https://fhir.example.org/fhir"
    blobServerUrl: "https://fhir.example.org/fhir"
    blobStore: "fhir-binary"
    senderName: "Parkview Medical Centre"
    linkLifetimeDays: 30
    publishRequestTasks: true
```

## Examples

A minimal install, serving the configuration built into the image:

```yaml
smartFormsHealthLinks:
  image: "my-registry/smart-forms-health-links:abc1234"
```

A single replica for a development cluster, reachable on a node port:

```yaml
smartFormsHealthLinks:
  image: "my-registry/smart-forms-health-links:abc1234"
  replicas: 1
  service:
    type: "NodePort"
```

## Upgrading

Upgrades are rolling: the new pods must pass their readiness probe before the
old ones are removed. Set `smartFormsHealthLinks.image` to a tag that names a
commit rather than a moving tag, otherwise Helm sees no change to apply and the
pods are not replaced.

## Uninstalling

```bash
helm uninstall smart-forms-health-links --namespace formlinks
```

Anything applied beside the release, such as an ingress, is not removed by
this and has to be deleted separately.

## Compatibility

| Chart version | App version | Kubernetes |
| ------------- | ----------- | ---------- |
| 0.1.0         | 0.1.0       | 1.19+      |
