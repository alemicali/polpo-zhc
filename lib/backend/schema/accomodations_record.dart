import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class AccomodationsRecord extends FirestoreRecord {
  AccomodationsRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  bool hasName() => _name != null;

  // "address" field.
  String? _address;
  String get address => _address ?? '';
  bool hasAddress() => _address != null;

  void _initializeFields() {
    _name = snapshotData['name'] as String?;
    _address = snapshotData['address'] as String?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('accomodations');

  static Stream<AccomodationsRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => AccomodationsRecord.fromSnapshot(s));

  static Future<AccomodationsRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => AccomodationsRecord.fromSnapshot(s));

  static AccomodationsRecord fromSnapshot(DocumentSnapshot snapshot) =>
      AccomodationsRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static AccomodationsRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      AccomodationsRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'AccomodationsRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is AccomodationsRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createAccomodationsRecordData({
  String? name,
  String? address,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'name': name,
      'address': address,
    }.withoutNulls,
  );

  return firestoreData;
}

class AccomodationsRecordDocumentEquality
    implements Equality<AccomodationsRecord> {
  const AccomodationsRecordDocumentEquality();

  @override
  bool equals(AccomodationsRecord? e1, AccomodationsRecord? e2) {
    return e1?.name == e2?.name && e1?.address == e2?.address;
  }

  @override
  int hash(AccomodationsRecord? e) =>
      const ListEquality().hash([e?.name, e?.address]);

  @override
  bool isValidKey(Object? o) => o is AccomodationsRecord;
}
