package main

import (
	"log"
	"os"

	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func newChaincode() (*contractapi.ContractChaincode, error) {
	chaincode, err := contractapi.NewChaincode(&CertificateContract{})
	if err != nil {
		return nil, err
	}
	chaincode.Info.Title = "PramanCertRegistry"
	chaincode.Info.Version = "1.0.0"
	return chaincode, nil
}

func main() {
	chaincode, err := newChaincode()
	if err != nil {
		log.Fatalf("create chaincode: %v", err)
	}

	// Chaincode-as-a-service: peers dial this process. The package id must match
	// the id returned by `peer lifecycle chaincode install`.
	ccid := os.Getenv("CHAINCODE_ID")
	address := os.Getenv("CHAINCODE_ADDRESS")
	if address == "" {
		address = "0.0.0.0:9999"
	}
	if ccid == "" {
		log.Fatal("CHAINCODE_ID is required")
	}

	server := &shim.ChaincodeServer{
		CCID:    ccid,
		Address: address,
		CC:      chaincode,
		TLSProps: shim.TLSProperties{
			Disabled: true,
		},
	}
	log.Printf("certregistry listening on %s", address)
	if err := server.Start(); err != nil {
		log.Fatalf("chaincode server: %v", err)
	}
}
