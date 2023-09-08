import {
  aws_ec2 as ec2,
  aws_secretsmanager as secretsmanager,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  EdgeDbServiceConstruct,
  EdgeDbServicePassthroughProps,
} from "./edge-db-service-construct";
import {
  EdgeDbLoadBalancerProtocolConstruct,
  EdgeDbLoadBalancerProtocolPassthroughProps,
} from "./edge-db-load-balancer-protocol-construct";
import { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import {
  EdgeDbLoadBalancerUiConstruct,
  EdgeDbLoadBalancerUiPassthroughProps,
} from "./edge-db-load-balancer-ui-construct";
import { ISecurityGroup } from "aws-cdk-lib/aws-ec2";

export interface EdgeDbProps {
  // a prefix that is used for constructing AWS secrets for edgedb
  secretsPrefix: string;

  // purely for information/descriptive purposes - the friendly short name of
  // the RDS instance we are wrapping
  rdsDatabaseDisplayName: string;

  // purely for secret naming purposes - the CDK safe id derived from
  // our RDS database name
  rdsDatabaseCdkIdSafeDbName: string;

  // the underlying network infrastructure that has already
  // been set up and that we will be installing into
  vpc: ec2.IVpc;

  // the configuration of the fargate service that is edge db itself
  edgeDbService: EdgeDbServicePassthroughProps;

  // the configuration of the internal network load balancer that provides EdgeDb protocol access
  edgeDbLoadBalancerProtocol: EdgeDbLoadBalancerProtocolPassthroughProps;

  // if present, configures a public UI for the EdgeDb instance
  edgeDbLoadBalancerUi?: EdgeDbLoadBalancerUiPassthroughProps;
}

/**
 * A construct wrapping an installation of EdgeDb as a service (assuming
 * an existing RDS postgres).
 */
export class EdgeDbConstruct extends Construct {
  private readonly _dsn: string;
  private readonly _edgeDbPasswordSecret: ISecret;
  private readonly _edgeDbSecurityGroup: ISecurityGroup;

  constructor(scope: Construct, id: string, props: EdgeDbProps) {
    super(scope, id);

    // create a new secret for our edge db database with an autogenerated password
    this._edgeDbPasswordSecret = new secretsmanager.Secret(
      this,
      "EdgeDbSecret",
      {
        description: `For database ${props.rdsDatabaseDisplayName} - secret containing EdgeDb super user password`,
        secretName: `${props.secretsPrefix}${props.rdsDatabaseCdkIdSafeDbName}EdgeDb`,
        generateSecretString: {
          excludePunctuation: true,
        },
      },
    );

    const edgeDbService = new EdgeDbServiceConstruct(this, "EdgeDbService", {
      ...props.edgeDbService,
      vpc: props.vpc,
      superUserSecret: this._edgeDbPasswordSecret,
    });

    this._edgeDbSecurityGroup = edgeDbService.securityGroup;

    const edgeDbLoadBalancer = new EdgeDbLoadBalancerProtocolConstruct(
      this,
      "EdgeDbLoadBalancerProtocol",
      {
        vpc: props.vpc,
        service: edgeDbService.service,
        servicePort: edgeDbService.servicePort,
        serviceSecurityGroup: edgeDbService.securityGroup,
        ...props.edgeDbLoadBalancerProtocol,
      },
    );

    const edgeDbPortString =
      props.edgeDbLoadBalancerProtocol.tcpPassthroughPort != 5656
        ? `:${props.edgeDbLoadBalancerProtocol.tcpPassthroughPort}`
        : "";

    this._dsn = `edgedb://${props.edgeDbService.superUser}@${edgeDbLoadBalancer.dnsName}${edgeDbPortString}`;

    new CfnOutput(this, "EdgeDbDsnNoPasswordOrDatabase", {
      value: this._dsn,
    });

    // only in development mode is the UI switched on and accessible
    if (props.edgeDbLoadBalancerUi) {
      const edgeDbLoadBalancerUi = new EdgeDbLoadBalancerUiConstruct(
        this,
        "EdgeDbLoadBalancerUi",
        {
          vpc: props.vpc,
          service: edgeDbService.service,
          servicePort: edgeDbService.servicePort,
          serviceSecurityGroup: edgeDbService.securityGroup,
          ...props.edgeDbLoadBalancerUi,
        },
      );

      const tlsPortString =
        props.edgeDbLoadBalancerUi.hostedPort != 443
          ? `:${props.edgeDbLoadBalancerUi.hostedPort}`
          : "";
      new CfnOutput(this, "EdgeDbUiUrl", {
        value: `https://${edgeDbLoadBalancerUi.dnsName}${tlsPortString}/ui`,
      });
    }
  }

  public get dsnForEnvironmentVariable(): string {
    return this._dsn;
  }

  public get passwordSecret(): ISecret {
    return this._edgeDbPasswordSecret;
  }

  public get securityGroup(): ISecurityGroup {
    return this._edgeDbSecurityGroup;
  }
}
