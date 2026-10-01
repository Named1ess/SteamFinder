param([string]$BaseUrl = 'http://localhost:8080')
$ErrorActionPreference = 'Stop'
function Assert-Condition($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-Run([string]$Id) { Invoke-RestMethod "$BaseUrl/api/runs/$Id" }
function Wait-Run([string]$Id) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $run = Get-Run $Id
        if ($run.status -notin @('queued', 'running')) { return $run }
        Start-Sleep -Milliseconds 500
    }
    throw 'Run did not finish after worker recovery'
}
$appConfig = Invoke-RestMethod "$BaseUrl/api/config"
Assert-Condition ($appConfig.mode -eq 'demo') 'Restart check requires demo mode'
docker compose stop worker | Out-Host
Assert-Condition ($LASTEXITCODE -eq 0) 'Cannot stop worker'
try {
    $body = @{ input = $appConfig.defaultRoot; depth = 3; maxNodes = 1000; maxRequests = 500; refresh = $true } | ConvertTo-Json
    $created = Invoke-RestMethod "$BaseUrl/api/runs" -Method Post -ContentType 'application/json' -Body $body
    $runId = $created.run.id
    docker compose start worker | Out-Host
    Assert-Condition ($LASTEXITCODE -eq 0) 'Cannot start worker'
    $observedRunning = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $running = Get-Run $runId
        if ($running.status -eq 'running') { $observedRunning = $true; break }
        if ($running.status -notin @('queued', 'running')) { break }
        Start-Sleep -Milliseconds 100
    }
    Assert-Condition $observedRunning 'Did not observe an active run; cannot claim crash recovery'
    docker compose kill -s SIGKILL worker | Out-Host
    Assert-Condition ($LASTEXITCODE -eq 0) 'Cannot interrupt worker'
    docker compose up -d --no-deps --force-recreate worker | Out-Host
    Assert-Condition ($LASTEXITCODE -eq 0) 'Cannot recreate worker'
    $finished = Wait-Run $runId
    Assert-Condition ($finished.status -eq 'completed') "Recovery did not complete: $($finished.status)"
    Assert-Condition ($finished.nodeCount -gt 15) 'Recovered graph is unexpectedly empty'
    Write-Output 'PASS: active worker SIGKILL/recreation resumes the same persisted run'

    docker compose up -d --no-deps --force-recreate db | Out-Host
    Assert-Condition ($LASTEXITCODE -eq 0) 'Cannot recreate database'
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        docker compose exec -T db pg_isready -U steamfinder -d steamfinder 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    docker compose up -d --no-deps --force-recreate api worker | Out-Host
    Assert-Condition ($LASTEXITCODE -eq 0) 'Cannot recreate API/worker'
    $restored = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try { $restored = Get-Run $runId; break } catch { Start-Sleep -Milliseconds 500 }
    }
    Assert-Condition ($null -ne $restored) 'Proxy did not reconnect to recreated API'
    Assert-Condition ($restored.nodeCount -eq $finished.nodeCount) 'Graph changed after database recreation'
    Assert-Condition ($restored.requestCount -eq $finished.requestCount) 'Restoring graph caused new external calls'
    Write-Output 'PASS: database volume survives container recreation; proxy reconnects; read causes no new requests'
} finally {
    docker compose up -d worker | Out-Host
}
