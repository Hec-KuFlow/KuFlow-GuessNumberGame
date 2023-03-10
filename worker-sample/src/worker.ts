/**
 * The MIT License
 * Copyright © 2021-present KuFlow S.L.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { KuFlowRestClient } from '@kuflow/kuflow-rest'
import { createKuFlowAsyncActivities, createKuFlowSyncActivities } from '@kuflow/kuflow-temporal-activity-kuflow'
import { KuFlowAuthorizationTokenProvider } from '@kuflow/kuflow-temporal-core'
import { NativeConnection, Worker } from '@temporalio/worker'
import fs from 'fs'
import YAML from 'yaml'


/**
 * Run a Worker with an mTLS connection, configuration is provided via environment variables.
 * Note that serverNameOverride and serverRootCACertificate are optional.
 */
async function main(): Promise<void> {
  const workerProperties = loadConfiguration()

  // Create a Temporal NativeConnection
  const connection = await NativeConnection.connect({
    address: workerProperties.temporal.target,
    tls: {
      serverNameOverride: workerProperties.temporal.mutualTls.serverNameOverride,
      serverRootCACertificate: Buffer.from(workerProperties.temporal.mutualTls.caData),
      // See docs for other TLS options
      clientCertPair: {
        crt: Buffer.from(workerProperties.temporal.mutualTls.certData),
        key: Buffer.from(workerProperties.temporal.mutualTls.keyData),
      },
    },
  })

  // Instantiate KuFlow rest client
  const kuFlowRestClient = new KuFlowRestClient(
    {
      clientId: workerProperties.kuflow.api.clientId,
      clientSecret: workerProperties.kuflow.api.clientSecret,
    },
    {
      endpoint: workerProperties.kuflow.api.endpoint,
    },
  )

  // Create a KuFlowAuthorizationTokenProvider
  const kuFlowTemporalConnection = KuFlowAuthorizationTokenProvider.instance({
    temporalConnection: connection,
    kuFlowRestClient,
  })

  const worker = await Worker.create({
    connection,
    namespace: workerProperties.temporal.namespace,
    workflowsPath: require.resolve('./workflows'),
    activities: {
      ...createKuFlowSyncActivities(kuFlowRestClient),
      ...createKuFlowAsyncActivities(kuFlowRestClient),
    },
    taskQueue: workerProperties.temporal.kuflowQueue,
  })
  console.log('Worker connection successfully established')

  await worker.run()
  await connection.close()
  await kuFlowTemporalConnection.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

// Helpers for configuring the mTLS client and worker samples

export interface WorkerProperties {
  kuflow: {
    api: {
      endpoint?: string
      clientId: string
      clientSecret: string
    }
  }
  temporal: {
    namespace: string
    kuflowQueue: string
    target: string
    mutualTls: {
      caData: string
      certData: string
      keyData: string
      serverNameOverride?: string
    }
  }
}

export function loadConfiguration(): WorkerProperties {
  const applicationFiles = fs.readFileSync('./application.yaml', 'utf8')
  const applicationYaml = YAML.parse(applicationFiles)

  return {
    kuflow: {
      api: {
        endpoint: findProperty(applicationYaml, 'kuflow.api.endpoint'),
        clientId: retrieveProperty(applicationYaml, 'kuflow.api.client-id'),
        clientSecret: retrieveProperty(applicationYaml, 'kuflow.api.client-secret'),
      },
    },
    temporal: {
      target: retrieveProperty(applicationYaml, 'temporal.target'),
      namespace: retrieveProperty(applicationYaml, 'temporal.namespace'),
      kuflowQueue: retrieveProperty(applicationYaml, 'temporal.kuflow-queue'),
      mutualTls: {
        caData: retrieveProperty(applicationYaml, 'temporal.mutual-tls.ca-data'),
        certData: retrieveProperty(applicationYaml, 'temporal.mutual-tls.cert-data'),
        keyData: retrieveProperty(applicationYaml, 'temporal.mutual-tls.key-data'),
        serverNameOverride: findProperty(applicationYaml, 'temporal.mutual-tls.server-name-override'),
      },
    },
  }
}

function retrieveProperty(config: any, path: string): string {
  const value = findProperty(config, path)
  if (value == null) {
    throw new ReferenceError(`${path} variable is not defined`)
  }

  return value
}

function findProperty(currentConfig: any, currentPath: string): string | undefined {
  const [property, ...restPath] = currentPath.split('.')
  const value = currentConfig[property]
  if (value == null) {
    return undefined
  }
  if (typeof value === 'object') {
    return findProperty(value, restPath.join('.'))
  }

  return value?.toString()
}
