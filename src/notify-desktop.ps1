# 弹一条 Windows 通知。被 @ 的时候用，人不一定开着 AgentChat 界面。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File notify-desktop.ps1 -Title "AgentChat" -Text "dsh 在 lumedit 里 @ 了你"
#
# 只用系统自带的 Windows.UI.Notifications，不装任何模块。
# 退出码 0 表示调用成功，1 表示这个环境不支持（远程会话、被策略关掉等）。

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Text,
  # 点了通知之后打开哪个地址，不给就只显示
  [string]$Url = ''
)

$ErrorActionPreference = 'Stop'

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

  # 文字要转义，消息里常有引号和尖括号
  $esc = { param($s) $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;' }
  $t = & $esc $Title
  $b = & $esc $Text

  $xml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$t</text>
      <text>$b</text>
    </binding>
  </visual>
</toast>
"@

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
