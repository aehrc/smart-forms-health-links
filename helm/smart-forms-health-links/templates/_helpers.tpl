{{/*
Origin the app is served from, as APP_ORIGIN.

An explicit `appOrigin` wins; otherwise it is derived from the ingress host, with the scheme
following whether TLS is terminated there. Rendering fails when neither is set, because this
value goes into the OAuth redirect URI and into every minted link, so a wrong or absent origin
breaks the launch rather than degrading it.
*/}}
{{- define "smartFormsHealthLinks.appOrigin" -}}
{{- $app := .Values.smartFormsHealthLinks -}}
{{- if $app.appOrigin -}}
{{- $app.appOrigin -}}
{{- else -}}
{{- $host := required "smartFormsHealthLinks.ingress.host is not set, so APP_ORIGIN cannot be derived. Set the ingress host, or set smartFormsHealthLinks.appOrigin to the origin the app is published on." $app.ingress.host -}}
{{- if $app.ingress.tls.enabled -}}
https://{{ $host }}
{{- else -}}
http://{{ $host }}
{{- end -}}
{{- end -}}
{{- end -}}
