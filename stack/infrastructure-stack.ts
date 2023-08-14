import {
  aws_secretsmanager as secretsmanager,
  Duration,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { InstanceBaseDatabase } from "./rds/instance-base-database";
import { smartVpcConstruct } from "./network/vpc";
import { Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { HostedZone, IHostedZone } from "aws-cdk-lib/aws-route53";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import { InfrastructureStackProps } from "./infrastructure-stack-props";
import { StringListParameter, StringParameter } from "aws-cdk-lib/aws-ssm";
import { HttpNamespace } from "aws-cdk-lib/aws-servicediscovery";
import { Port, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import { camelCase } from "lodash";
import { BaseDatabase } from "./rds/base-database";
import { ServerlessBaseDatabase } from "./rds/serverless-base-database";
import { EdgeDbConstruct } from "./edge-db/edge-db-construct";
import {
  databaseEdgeDbAdminPasswordSecretArnParameterName,
  databaseEdgeDbDsnNoPasswordOrDatabaseParameterName,
  databaseEdgeDbSecurityGroupIdParameterName,
  secretsManagerSecretsPrefixParameterName,
  vpcAvailabilityZonesParameterName,
  vpcIdParameterName,
  vpcInternalSecurityGroupIdParameterName,
  vpcIsolatedSubnetIdsParameterName,
  vpcIsolatedSubnetRouteTableIdsParameterName,
  vpcPrivateSubnetIdsParameterName,
  vpcPrivateSubnetRouteTableIdsParameterName,
  vpcPublicSubnetIdsParameterName,
  vpcPublicSubnetRouteTableIdsParameterName,
  vpcSecurityGroupIdParameterName,
} from "elsa-data-aws-infrastructure-shared";

export {
  InfrastructureStackProps,
  InfrastructureStackNamespaceProps,
  InfrastructureStackDnsProps,
  InfrastructureStackNetworkProps,
} from "./infrastructure-stack-props";
export {
  PostgresCommon,
  PostgresCommonMonitoring,
  EdgeDbCommon,
  EdgeDbPublic,
} from "./infrastructure-stack-database-props";

/**
 * A basic infrastructure stack that supports
 * - vpc/network - either as a new VPC or re-using existing
 * - a namespace
 * - a DNS zone and certificate
 * - a private bucket for temporary objects (with auto expiry)
 * - postgres databases
 * - edgedb databases
 */
export class InfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props: InfrastructureStackProps) {
    super(scope, id, props);

    this.templateOptions.description = props.description;

    const vpc = smartVpcConstruct(
      this,
      "VPC",
      props.network.vpcNameOrDefaultOrUndefined,
      false
    );

    // https://lzygo1995.medium.com/how-to-share-information-between-stacks-through-ssm-parameter-store-in-cdk-1a64e4e9d83a

    new StringParameter(this, "VpcIdParameter", {
      parameterName: vpcIdParameterName(id),
      stringValue: vpc.vpcId,
    });

    new StringListParameter(this, "AvailabilityZonesParameter", {
      parameterName: vpcAvailabilityZonesParameterName(id),
      stringListValue: vpc.availabilityZones,
    });

    new StringListParameter(this, "PublicSubnetIdsParameter", {
      parameterName: vpcPublicSubnetIdsParameterName(id),
      stringListValue: vpc.publicSubnets.map((a) => a.subnetId),
    });

    new StringListParameter(this, "PublicSubnetRouteTableIdsParameter", {
      parameterName: vpcPublicSubnetRouteTableIdsParameterName(id),
      stringListValue: vpc.publicSubnets.map((a) => a.routeTable.routeTableId),
    });

    new StringListParameter(this, "PrivateSubnetIdsParameter", {
      parameterName: vpcPrivateSubnetIdsParameterName(id),
      stringListValue: vpc.privateSubnets.map((a) => a.subnetId),
    });

    new StringListParameter(this, "PrivateSubnetRouteTableIdsParameter", {
      parameterName: vpcPrivateSubnetRouteTableIdsParameterName(id),
      stringListValue: vpc.privateSubnets.map((a) => a.routeTable.routeTableId),
    });

    new StringListParameter(this, "IsolatedSubnetIdsParameter", {
      parameterName: vpcIsolatedSubnetIdsParameterName(id),
      stringListValue: vpc.isolatedSubnets.map((a) => a.subnetId),
    });

    new StringListParameter(this, "IsolatedSubnetRouteTableIdsParameter", {
      parameterName: vpcIsolatedSubnetRouteTableIdsParameterName(id),
      stringListValue: vpc.isolatedSubnets.map(
        (a) => a.routeTable.routeTableId
      ),
    });

    {
      const sg = new SecurityGroup(this, "SecurityGroup", {
        vpc: vpc,
        description: "Security group for general resources in the VPC",
      });

      new StringParameter(this, "SecurityGroupIdParameter", {
        parameterName: vpcSecurityGroupIdParameterName(id),
        stringValue: sg.securityGroupId,
      });
    }

    {
      const internalSg = new SecurityGroup(this, "InternalSecurityGroup", {
        vpc: vpc,
        description:
          "Security group for resources in the VPC that only allows connections from/to other resources in the group",
        allowAllOutbound: false,
        allowAllIpv6Outbound: false,
      });

      internalSg.addIngressRule(internalSg, Port.allTraffic());
      internalSg.addEgressRule(internalSg, Port.allTraffic());

      new StringParameter(this, "InternalSecurityGroupIdParameter", {
        parameterName: vpcInternalSecurityGroupIdParameterName(id),
        stringValue: internalSg.securityGroupId,
      });
    }

    /* EXAMINING THE USE OF MANAGED PREFIX LIST TO CONTROL ACCESS TO "DEBUG" PORTS - WIP UNUSED
    {
      // AS10148 University of Melbourne
      const uniMelbCidr = [
        "203.21.130.0/23",
        "192.231.127.0/24",
        "192.43.208.0/24",
        "203.5.64.0/21",
        "45.113.232.0/22",
        "103.6.252.0/22",
        "103.12.108.0/22",
        "128.250.0.0/16",
        "192.43.207.0/24",
        "115.146.80.0/20",
        "192.101.254.0/24",
        "203.0.40.0/24",
        "192.43.209.0/24",
      ];

      // AS7545 TPG Internet Pty Ltd
      const tpgCidr = ["220.240.0.0/16"];

      const allCidr = uniMelbCidr.concat(tpgCidr);

      const developerCfnPrefixList = new CfnPrefixList(
        this,
        "DeveloperCfnPrefixList",
        {
          addressFamily: "IPv4",
          maxEntries: allCidr.length,
          prefixListName: `${Names.uniqueId(this)}developerManagedPrefixList`,
          entries: allCidr.map((cidr) => ({
            cidr,
          })),
        }
      );

      new StringParameter(this, "DeveloperManagedPrefixListParameter", {
        parameterName: `/${id}/VPC/developerManagedPrefixList`,
        stringValue: developerCfnPrefixList.attrPrefixListId,
      });
    } */

    // we export the secrets prefix so it can be used by application stacks
    // for setting a tight (yet wildcarded) policy
    new StringParameter(this, "SecretsPrefixParameter", {
      parameterName: secretsManagerSecretsPrefixParameterName(id),
      stringValue: props.secretsPrefix,
    });

    // the temp bucket is a useful artifact to allow us to construct S3 objects
    // that we know will automatically cycle/destroy
    const tempPrivateBucket = new Bucket(this, "TempPrivateBucket", {
      // note we set this up for DESTROY and autoDeleteObjects, irrespective of isDevelopment - it is *meant* to be a
      // temporary bucket
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // for temporary data there is no need to keep multiple versions
      versioned: false,
      // private temporary data
      publicReadAccess: false,
      // we don't expect there to be writes from other accounts
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // aws managed is fine
      encryption: BucketEncryption.S3_MANAGED,
      // a bucket that can expire objects over different expiration delays depending on prefix
      lifecycleRules: [
        {
          // we have no reasons to allow multipart uploads over long periods
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          // we are actually set to version: false, but no harm setting this
          noncurrentVersionExpiration: Duration.days(1),
          // nothing stays around longer than a year
          expiration: Duration.days(365),
        },
        {
          // a prefix for very temporary objects
          prefix: "1/",
          expiration: Duration.days(1),
        },
        {
          prefix: "7/",
          expiration: Duration.days(7),
        },
        {
          prefix: "30/",
          expiration: Duration.days(30),
        },
        {
          prefix: "90/",
          expiration: Duration.days(90),
        },
      ],
    });

    /* INFRASTRUCTURE THAT WOULD ALLOW CONTROLLED "PUBLIC" SHARING OF ARTIFACTS (cloud formations etc)
       DISABLED DUE TO SCP POLICIES AT UMCCR

    const tempPublicBucket = new Bucket(this, "TempPublicBucket", {
      // note we set this up for DESTROY and autoDeleteObjects, irrespective of isDevelopment - it is *meant* to be a
      // temporary bucket
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      publicReadAccess: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      // a bucket that can expire objects over different expiration delays depending on prefix
      lifecycleRules: [
        {
          // we have no reasons to allow multipart uploads over long periods
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          // we are actually set to version: false, but no harm setting this
          noncurrentVersionExpiration: Duration.days(1),
        },
        {
          prefix: "1/",
          expiration: Duration.days(1),
        },
        {
          prefix: "7/",
          expiration: Duration.days(7),
        },
        {
          prefix: "30/",
          expiration: Duration.days(30),
        },
        {
          prefix: "90/",
          expiration: Duration.days(90),
        },
      ],
    });*/

    new StringParameter(this, "TempPrivateBucketArnParameter", {
      parameterName: `/${id}/TempPrivateBucket/bucketArn`,
      stringValue: tempPrivateBucket.bucketArn,
    });

    new StringParameter(this, "TempPrivateBucketNameParameter", {
      parameterName: `/${id}/TempPrivateBucket/bucketName`,
      stringValue: tempPrivateBucket.bucketName,
    });

    if (props.ns) {
      const ns = new HttpNamespace(this, "Namespace", {
        name: props.ns.name,
      });

      new StringParameter(this, "NamespaceNameParameter", {
        parameterName: `/${id}/HttpNamespace/namespaceName`,
        stringValue: ns.namespaceName,
      });

      new StringParameter(this, "NamespaceIdParameter", {
        parameterName: `/${id}/HttpNamespace/namespaceId`,
        stringValue: ns.namespaceId,
      });

      new StringParameter(this, "NamespaceArnParameter", {
        parameterName: `/${id}/HttpNamespace/namespaceArn`,
        stringValue: ns.namespaceArn,
      });
    }

    let hz: IHostedZone | undefined = undefined;
    let cert: Certificate | undefined = undefined;

    if (props.dns) {
      hz = HostedZone.fromLookup(this, "HostedZone", {
        domainName: props.dns.hostedZoneName,
      });

      cert = new Certificate(this, "WildcardCertificate", {
        domainName: `*.${props.dns.hostedZoneName}`,
        subjectAlternativeNames: [props.dns.hostedZoneName],
        validation: CertificateValidation.fromDns(hz),
      });

      new StringParameter(this, "ZoneNameParameter", {
        parameterName: `/${id}/HostedZone/zoneName`,
        stringValue: hz.zoneName,
      });

      new StringParameter(this, "HostedZoneIdParameter", {
        parameterName: `/${id}/HostedZone/hostedZoneId`,
        stringValue: hz.hostedZoneId,
      });

      new StringParameter(this, "CertificateArnParameter", {
        parameterName: `/${id}/Certificate/certificateArn`,
        stringValue: cert.certificateArn,
      });
    }

    if (props.databases) {
      for (const dbConfig of props.databases) {
        if (!/[a-zA-Z0-9_.]+/.test(dbConfig.name))
          throw new Error(
            `The database name ${dbConfig.name} doesn't meet the limited list of allowed characters (the name is used in SSM etc)`
          );

        let cdkIdSafeDbName = camelCase(dbConfig.name);

        // from above - the length of this must be > 0
        // anyhow we want first chat to be capital if possible
        cdkIdSafeDbName =
          cdkIdSafeDbName[0].toUpperCase() + cdkIdSafeDbName.slice(1);

        // create a new secret for our base database with an autogenerated password
        const baseDbSecret = new secretsmanager.Secret(
          this,
          `${cdkIdSafeDbName}Secret`,
          {
            description: `For database ${dbConfig.name} - secret containing RDS details such as admin username and password`,
            secretName: props.secretsPrefix
              ? `${props.secretsPrefix}${cdkIdSafeDbName}Rds`
              : undefined,
            generateSecretString: {
              excludePunctuation: true,
              secretStringTemplate: JSON.stringify({
                username: dbConfig.adminUser,
                password: "",
              }),
              generateStringKey: "password",
            },
          }
        );

        let baseDb: BaseDatabase;

        switch (dbConfig.postgresType) {
          case "postgres-instance":
            baseDb = new InstanceBaseDatabase(this, cdkIdSafeDbName, {
              vpc: vpc,
              databaseName: dbConfig.name,
              secret: baseDbSecret,
              ...dbConfig,
            });
            break;
          case "postgres-serverless-2":
            baseDb = new ServerlessBaseDatabase(this, cdkIdSafeDbName, {
              vpc: vpc,
              databaseName: dbConfig.name,
              secret: baseDbSecret,
              ...dbConfig,
            });
            break;
          default:
            throw new Error(
              `Unknown postgres database type ${dbConfig.postgresType}`
            );
        }

        // TODO this actually resolves our tokens as it stores it - which is not what
        // new StringParameter(this, "DatabaseDsnWithTokensParameter", {
        //  parameterName: `/${id}/Database/dsnWithTokens`,
        //  stringValue: baseDb.dsnWithTokens,
        //});

        // we want
        new StringParameter(
          this,
          `${cdkIdSafeDbName}DatabaseDsnWithPasswordParameter`,
          {
            parameterName: `/${id}/Database/${dbConfig.name}/dsnWithPassword`,
            stringValue: baseDb.dsnWithTokens,
          }
        );

        new StringParameter(
          this,
          `${cdkIdSafeDbName}DatabaseDsnNoPasswordParameter`,
          {
            parameterName: `/${id}/Database/${dbConfig.name}/dsnNoPassword`,
            stringValue: baseDb.dsnNoPassword,
          }
        );

        new StringParameter(
          this,
          `${cdkIdSafeDbName}DatabaseHostnameParameter`,
          {
            parameterName: `/${id}/Database/${dbConfig.name}/hostname`,
            stringValue: baseDb.hostname,
          }
        );

        new StringParameter(this, `${cdkIdSafeDbName}DatabasePortParameter`, {
          parameterName: `/${id}/Database/${dbConfig.name}/port`,
          stringValue: baseDb.port.toString(),
        });

        new StringParameter(
          this,
          `${cdkIdSafeDbName}DatabaseAdminUserParameter`,
          {
            parameterName: `/${id}/Database/${dbConfig.name}/adminUser`,
            stringValue: dbConfig.adminUser,
          }
        );

        new StringParameter(
          this,
          `${cdkIdSafeDbName}DatabaseAdminPasswordSecretArnParameter`,
          {
            parameterName: `/${id}/Database/${dbConfig.name}/adminPasswordSecretArn`,
            stringValue: baseDbSecret.secretArn,
          }
        );

        new StringParameter(
          this,
          `${cdkIdSafeDbName}DatabaseSecurityGroupIdParameter`,
          {
            parameterName: `/${id}/Database/${dbConfig.name}/securityGroupId`,
            stringValue: baseDb.securityGroup.securityGroupId,
          }
        );

        if (dbConfig.edgeDb) {
          // there are some conditions we need to abort on
          if (dbConfig.edgeDb.makePubliclyReachable)
            if (!cert || !hz)
              throw new Error(
                "If the UI is going to be switched on for EdgeDb then a certificate and hosted zone also needs to be specified"
              );

          /**
           * Create EdgeDb server
           */
          const edgeDb = new EdgeDbConstruct(this, `${cdkIdSafeDbName}EdgeDb`, {
            vpc: vpc,
            rdsDatabaseDisplayName: dbConfig.name,
            rdsDatabaseCdkIdSafeDbName: cdkIdSafeDbName,
            secretsPrefix: props.secretsPrefix,
            edgeDbService: {
              baseDbDsn: baseDb.dsnWithTokens,
              baseDbSecurityGroup: baseDb.securityGroup,
              desiredCount: 1,
              cpu: dbConfig.edgeDb.cpu ?? 1024,
              memory: dbConfig.edgeDb.memoryLimitMiB ?? 2048,
              superUser: "elsa_superuser",
              edgeDbVersion: dbConfig.edgeDb.version,
              enableUiFeatureFlag: !!dbConfig.edgeDb.makePubliclyReachable,
            },
            edgeDbLoadBalancerProtocol: {
              tcpPassthroughPort: dbConfig.edgeDb.dbPort || 5656,
            },
            edgeDbLoadBalancerUi: dbConfig.edgeDb.makePubliclyReachable
              ? {
                  hostedPort:
                    dbConfig.edgeDb.makePubliclyReachable.uiPort ?? 443,
                  hostedPrefix: dbConfig.edgeDb.makePubliclyReachable.urlPrefix,
                  hostedCertificate: cert!,
                  hostedZone: hz!,
                }
              : undefined,
          });

          new StringParameter(
            this,
            `${cdkIdSafeDbName}DatabaseEdgeDbDsnNoPasswordOrDatabaseParameter`,
            {
              parameterName: databaseEdgeDbDsnNoPasswordOrDatabaseParameterName(
                id,
                dbConfig.name
              ),
              stringValue: edgeDb.dsnForEnvironmentVariable,
            }
          );

          new StringParameter(
            this,
            `${cdkIdSafeDbName}DatabaseEdgeDbAdminPasswordSecretArnParameter`,
            {
              parameterName: databaseEdgeDbAdminPasswordSecretArnParameterName(
                id,
                dbConfig.name
              ),
              stringValue: edgeDb.passwordSecret.secretArn,
            }
          );

          new StringParameter(
            this,
            `${cdkIdSafeDbName}DatabaseEdgeDbSecurityGroupIdParameter`,
            {
              parameterName: databaseEdgeDbSecurityGroupIdParameterName(
                id,
                dbConfig.name
              ),
              stringValue: edgeDb.securityGroup.securityGroupId,
            }
          );
        }
      }
    }
  }
}
