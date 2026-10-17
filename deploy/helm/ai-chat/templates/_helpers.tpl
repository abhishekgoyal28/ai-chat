{{- define "ai-chat.fullname" -}}
{{- printf "%s" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "ai-chat.labels" -}}
app.kubernetes.io/name: ai-chat
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "ai-chat.selector" -}}
app.kubernetes.io/name: ai-chat
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "ai-chat.secretName" -}}
{{- if .Values.existingSecret }}{{ .Values.existingSecret }}{{ else }}{{ include "ai-chat.fullname" . }}-secrets{{ end -}}
{{- end -}}

{{- define "ai-chat.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ include "ai-chat.fullname" . }}{{ else }}default{{ end -}}
{{- end -}}

{{/* Environment shared by every container: the ConfigMap, the Secret, and the public URL. */}}
{{- define "ai-chat.env" -}}
envFrom:
  - configMapRef:
      name: {{ include "ai-chat.fullname" . }}-config
  - secretRef:
      name: {{ include "ai-chat.secretName" . }}
{{- end -}}

{{/*
One Deployment. Called with (dict "root" $ "component" "chat-app" "spec" .Values.chatApp "port" 3000)
*/}}
{{- define "ai-chat.deployment" -}}
{{- $root := .root -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ai-chat.fullname" $root }}-{{ .component }}
  labels:
    {{- include "ai-chat.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  {{- if not .spec.autoscaling.enabled }}
  replicas: {{ .spec.replicas }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "ai-chat.selector" . | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  template:
    metadata:
      labels:
        {{- include "ai-chat.selector" . | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
        checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
        prometheus.io/port: {{ .port | quote }}
        {{- with $root.Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      serviceAccountName: {{ include "ai-chat.serviceAccountName" $root }}
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets: {{- toYaml . | nindent 8 }}
      {{- end }}
      # Long enough for in-flight generations and socket drains to finish.
      terminationGracePeriodSeconds: 60
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: {{ .component }}
          image: "{{ $root.Values.image.repository }}:{{ $root.Values.image.tag }}"
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          command: ["node", "dist/{{ .component }}/main.js"]
          ports:
            - name: http
              containerPort: {{ .port }}
          {{- include "ai-chat.env" $root | nindent 10 }}
          env:
            - name: PUBLIC_APP_URL
              value: {{ $root.Values.publicUrl | quote }}
            - name: APP_PORT
              value: "3000"
            - name: SOCKET_PORT
              value: "3001"
            - name: EXPERT_PORT
              value: "3002"
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            initialDelaySeconds: 20
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          lifecycle:
            # Let the load balancer stop routing here before SIGTERM arrives.
            preStop:
              exec: { command: ["sleep", "10"] }
          resources:
            {{- toYaml .spec.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - { name: tmp, emptyDir: {} }
      {{- with $root.Values.nodeSelector }}
      nodeSelector: {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.tolerations }}
      tolerations: {{- toYaml . | nindent 8 }}
      {{- end }}
      affinity:
        {{- if $root.Values.affinity }}
        {{- toYaml $root.Values.affinity | nindent 8 }}
        {{- else }}
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels:
                    {{- include "ai-chat.selector" . | nindent 20 }}
        {{- end }}
{{- end -}}
